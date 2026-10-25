/** Windows Credential Manager generic credentials, native advapi32; never temporary credential files or PowerShell. */
import { stateKey } from "../secrets/backends.js";
import type { AccountSecretBackend, AccountSecretField, SocialProvider } from "./account-secrets.js";
type NativeFunction = (...args: unknown[]) => unknown;
export interface CredentialFfi {
  struct(name: string, fields: Record<string, string>): unknown;
  load(library: string): { func(signature: string): NativeFunction };
  decode(pointer: unknown, type: unknown): Record<string, unknown>;
  view(pointer: unknown, length: number): ArrayBuffer;
}
interface CredentialApi {
  get(target: string): string | undefined;
  set(target: string, value: string): void;
  delete(target: string): void;
}
const bindings = new WeakMap<object, CredentialApi>();
export function bindCredentialManager(ffi: CredentialFfi): CredentialApi {
  const hit = bindings.get(ffi);
  if (hit) return hit;
  const type = ffi.struct("CROT_ACCOUNT_CREDENTIALW", {
    Flags: "uint32_t",
    Type: "uint32_t",
    TargetName: "str16",
    Comment: "str16",
    LastWritten: "uint64_t",
    CredentialBlobSize: "uint32_t",
    CredentialBlob: "void *",
    Persist: "uint32_t",
    AttributeCount: "uint32_t",
    Attributes: "void *",
    TargetAlias: "str16",
    UserName: "str16",
  });
  const dll = ffi.load("advapi32.dll"),
    kernel = ffi.load("kernel32.dll");
  const read = dll.func(
    "int __stdcall CredReadW(str16 target, uint32_t type, uint32_t flags, _Out_ CROT_ACCOUNT_CREDENTIALW **credential)",
  );
  const write = dll.func("int __stdcall CredWriteW(CROT_ACCOUNT_CREDENTIALW *credential, uint32_t flags)");
  const remove = dll.func("int __stdcall CredDeleteW(str16 target, uint32_t type, uint32_t flags)");
  const free = dll.func("void __stdcall CredFree(void *buffer)");
  const error = kernel.func("uint32_t __stdcall GetLastError()");
  const api = {
    get(target: string): string | undefined {
      const out: unknown[] = [null];
      if (!read(target, 1, 0, out)) {
        if (Number(error()) === 1168) return undefined;
        throw new Error("Credential Manager read failed");
      }
      try {
        const c = ffi.decode(out[0], type),
          size = Number(c.CredentialBlobSize);
        if (!Number.isSafeInteger(size) || size < 1 || size > 2560 || !c.CredentialBlob)
          throw new Error("Invalid Credential Manager item");
        return Buffer.from(ffi.view(c.CredentialBlob, size)).toString("utf8");
      } finally {
        free(out[0]);
      }
    },
    set(target: string, value: string) {
      const data = Buffer.from(value, "utf8");
      if (!data.length || data.length > 2560) throw new Error("Credential Manager value exceeds supported size");
      if (
        !write(
          {
            Flags: 0,
            Type: 1,
            TargetName: target,
            Comment: "CROT OAuth account",
            LastWritten: 0,
            CredentialBlobSize: data.length,
            CredentialBlob: data,
            Persist: 2,
            AttributeCount: 0,
            Attributes: null,
            TargetAlias: null,
            UserName: "CROT",
          },
          0,
        )
      )
        throw new Error("Credential Manager write failed");
    },
    delete(target: string) {
      if (!remove(target, 1, 0) && Number(error()) !== 1168) throw new Error("Credential Manager deletion failed");
    },
  };
  bindings.set(ffi, api);
  return api;
}
export async function createCredentialManager(stateDir: string): Promise<AccountSecretBackend> {
  if (process.platform !== "win32") throw new Error("Credential Manager requires Windows");
  const moduleName: string = "koffi";
  const module = await import(moduleName);
  const ffi = (module.default ?? module) as CredentialFfi;
  const api = bindCredentialManager(ffi),
    prefix = `crot.accounts:${stateKey(stateDir)}:`;
  const key = (p: SocialProvider, f: AccountSecretField) => prefix + p + ":" + f;
  return {
    kind: "credential-manager",
    get: async (p, f) => api.get(key(p, f)),
    set: async (p, f, v) => api.set(key(p, f), v),
    delete: async (p, f) => api.delete(key(p, f)),
  };
}
