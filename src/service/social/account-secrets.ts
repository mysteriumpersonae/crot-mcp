/** Account credentials have NO plaintext/file/DPAPI-file fallback. No renderer API exposes this store. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPrivateFileProtection } from "../../core/platform/private-files.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import {
  createKeychainBackend,
  createLibsecretBackend,
  findExecutable,
  writePrivateFileAtomic,
} from "../secrets/backends.js";
import { readSecretsMarker } from "../secrets/store.js";
import type { SecretName } from "../secrets/types.js";
import { createCredentialManager } from "./credential-manager.js";

export const SocialProviderSchema = z.enum(["youtube", "tiktok", "x", "github", "notion"]);
export type SocialProvider = z.infer<typeof SocialProviderSchema>;
export const SOCIAL_PROVIDERS = SocialProviderSchema.options;
export type AccountSecretField = "access" | "refresh" | "clientSecret";
export interface AccountSecretBackend {
  readonly kind: "keychain" | "credential-manager" | "secret-service";
  get(provider: SocialProvider, field: AccountSecretField): Promise<string | undefined>;
  set(provider: SocialProvider, field: AccountSecretField, value: string): Promise<void>;
  delete(provider: SocialProvider, field: AccountSecretField): Promise<void>;
}
const fields: readonly AccountSecretField[] = ["access", "refresh", "clientSecret"];
/** Fixed generated names only; independent namespace, never included in generic secrets rotation/migration. */
const item = (provider: SocialProvider, field: AccountSecretField): SecretName =>
  `oauth-${SocialProviderSchema.parse(provider)}-${field}` as SecretName;
const validate = (value: string) => {
  if (!value || Buffer.byteLength(value) > 2560 || /[\r\n\0]/.test(value))
    throw new Error("Invalid account credential");
};
export class AccountSecrets {
  constructor(private readonly backend: AccountSecretBackend) {}
  get kind() {
    return this.backend.kind;
  }
  async read(provider: SocialProvider, field: AccountSecretField): Promise<string | undefined> {
    try {
      const value = await this.backend.get(provider, field);
      if (value !== undefined) validate(value);
      return value;
    } catch {
      throw new Error("System account secret read failed");
    }
  }
  async write(provider: SocialProvider, field: AccountSecretField, value: string): Promise<void> {
    validate(value);
    try {
      await this.backend.set(provider, field, value);
    } catch {
      throw new Error("System account secret write failed");
    }
    let back: string | undefined;
    try {
      back = await this.backend.get(provider, field);
    } catch {
      throw new Error("Account secret read-back failed");
    }
    if (back !== value) throw new Error("Account secret read-back failed");
  }
  /** Attempt every deletion even if one fails, then verify absence. Never silently report disconnected on failure. */
  async clear(provider: SocialProvider, credentialsOnly = false): Promise<void> {
    const selected = credentialsOnly ? fields.filter((f) => f !== "clientSecret") : fields;
    const results = await Promise.allSettled(
      selected.map(async (field) => {
        await this.backend.delete(provider, field);
        if ((await this.backend.get(provider, field)) !== undefined) throw new Error("Account secret deletion failed");
      }),
    );
    if (results.some((r) => r.status === "rejected"))
      throw new Error("Account secrets could not be completely removed from system storage");
  }
}

const DescriptorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["keychain", "credential-manager", "secret-service"]),
    keychain: z.string().min(1).max(4096).optional(),
  })
  .strict();
export async function accountStoreDescriptor(
  stateDir: string,
  privateFiles: PrivateFileProtection,
  platform: NodeJS.Platform = process.platform,
) {
  const file = path.join(stateDir, "oauth-secret-store.json");
  const expected =
    platform === "win32"
      ? "credential-manager"
      : platform === "darwin"
        ? "keychain"
        : platform === "linux"
          ? "secret-service"
          : undefined;
  if (!expected) throw new Error("System account secret storage is unavailable on this platform");
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Account secret-store descriptor could not be read");
  }
  if (raw !== undefined) {
    if (raw.length > 8192) throw new Error("Invalid account secret-store descriptor");
    const marker = DescriptorSchema.parse(JSON.parse(raw));
    if (marker.kind !== expected || (marker.keychain !== undefined && marker.kind !== "keychain"))
      throw new Error("Account system-store migration requires explicit owner action");
    return marker;
  }
  const generic = platform === "darwin" ? await readSecretsMarker(stateDir) : undefined;
  const marker = DescriptorSchema.parse({
    version: 1,
    kind: expected,
    ...(generic?.backend === "keychain" && generic.keychain ? { keychain: generic.keychain } : {}),
  });
  await privateFiles.ensureDirectory(stateDir);
  await writePrivateFileAtomic(file, JSON.stringify(marker) + "\n", privateFiles);
  return marker;
}
export async function openAccountSecrets(
  stateDir: string,
  privateFiles = createPrivateFileProtection(process.platform === "win32"),
): Promise<AccountSecrets> {
  const descriptor = await accountStoreDescriptor(stateDir, privateFiles);
  if (descriptor.kind === "credential-manager") return new AccountSecrets(await createCredentialManager(stateDir));
  if (descriptor.kind === "keychain") {
    const backend = createKeychainBackend(stateDir, { keychain: descriptor.keychain });
    return new AccountSecrets({
      kind: "keychain",
      get: (p, f) => backend.get(item(p, f)),
      set: (p, f, v) => backend.set(item(p, f), v),
      delete: (p, f) => backend.delete(item(p, f)),
    });
  }
  const tool = await findExecutable("secret-tool");
  if (!tool)
    throw new Error("OAuth requires an unlocked Secret Service and secret-tool; plaintext fallback is disabled");
  const backend = createLibsecretBackend(stateDir, { tool });
  return new AccountSecrets({
    kind: "secret-service",
    get: (p, f) => backend.get(item(p, f)),
    set: (p, f, v) => backend.set(item(p, f), v),
    delete: (p, f) => backend.delete(item(p, f)),
  });
}
