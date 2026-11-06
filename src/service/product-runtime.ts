import { publicationProtection } from "./publications/authorization.js";
import { PublicationAuditSchema } from "../core/publications/service.js";
import { AccountAvatars } from "./social/avatars.js";
import type { SocialAccountRuntime } from "./social/runtime.js";
import type { SocialProvider } from "./social/account-secrets.js";
import { PLAN_CATALOG } from "../account-service/catalog.js";
import { checkLoopbackPort } from "./system-check.js";
import { parseTabPolicy, type BrowserTabPolicy } from "../core/capabilities/browser/tab-policy.js";
import { CONNECTOR_MANIFESTS, SkillSchema, type CustomSkill } from "./connector-manifests.js";
/** AD-40: service-owned product state. Metadata and encrypted request/credential vault are separate. */
import {
  ChatRuntime,
  CHAT_ENDPOINTS,
  chatEndpoint,
  customLabel,
  customSlug,
  providerDiagnostic,
  providerNetworkHosts,
  type ChatProviderConfig,
} from "./chat-runtime.js";
import {
  baseProvider,
  isCustomFamily,
  isProfileKey,
  type ChatProvider,
  type CustomProviderFamily,
} from "./chat-protocol.js";
import { newAuditEventId } from "../core/audit/audit.js";
import { RuntimePolicySchema, type RuntimePolicy } from "../core/permissions/runtime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { executeExternalMcp } from "../core/capabilities/mcp/external.js";
import { CrotError } from "../core/errors.js";
import { localPrincipal, type AuthContext } from "../core/auth/principal.js";
import type { CrotCore } from "../core/crot-core.js";
import type { PrivateFileProtection, ManagedProcess } from "../core/platform/types.js";
import type { SecretStore } from "./secrets/store.js";
import { writePrivateFileAtomic } from "./secrets/backends.js";
import { parseProduct, type ProductMethod } from "./product-protocol.js";
import { OPENCODE_INSTALL_COMMAND, OpenCodeBridge, type OpenCodeBridgeOptions } from "./opencode-bridge.js";
import { findOpenCodeKey } from "./opencode-local.js";
import { OpenCodeRuntime, type OpenCodeInstallHost } from "./opencode-runtime.js";

export const CONNECTOR_IDS = CONNECTOR_MANIFESTS.map((m) => m.id);
interface Project {
  id: string;
  name: string;
  path: string;
  favorite: boolean;
  lastOpened: string;
  tools: string[];
  agents: string[];
  connectors: string[];
}
interface Agent {
  id: string;
  name: string;
  kind: string;
  transport?: string;
  connected: boolean;
  projects: string[];
  browser: boolean;
  requestsPerMinute: number;
  revoked: boolean;
  calls: number;
  lastSeen: string;
}
interface Connector {
  id: string;
  configured: boolean;
  enabled: boolean;
  endpoint?: string;
  scopes: string[];
  projects: string[];
  agents: string[];
  checkedAt?: string;
  latencyMs?: number;
  status: string;
  httpStatus?: number;
}
interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  status: string;
  tools: { name: string; inputSchema: Record<string, unknown>; description?: string }[];
  resources: unknown[];
  policy: Record<string, boolean>;
  logs: { time: string; event: string }[];
}
interface Task {
  id: string;
  operation: string;
  project: string;
  agent: string;
  connector?: string;
  state: string;
  progress: number;
  startedAt: string;
  endedAt?: string;
  processId?: string;
  artifacts: string[];
  retryable: boolean;
  errorCode?: string;
}
interface State {
  version: 1;
  active: string;
  launchWorkspace?: string;
  projects: Project[];
  agents: Agent[];
  connectors: Connector[];
  servers: McpServer[];
  tasks: Task[];
  onboarding?: { completedStep: number; updatedAt: string };
  browserPolicy?: BrowserTabPolicy;
  browserPolicyPrevious?: BrowserTabPolicy;
  browserAccess?: { read: boolean; navigation: boolean };
  browserAccessPrevious?: { read: boolean; navigation: boolean } | null;
  skills?: CustomSkill[];
  chatProviders?: Partial<Record<ChatProvider, ChatProviderConfig>>;
  security?: RuntimePolicy;
  /** Uncommitted policy transaction: restart must restore this prior policy. */
  securityPrevious?: RuntimePolicy;
}
interface Vault {
  credentials: Record<string, string>;
  replays: Record<
    string,
    {
      member: string;
      method: string;
      input: unknown[];
      context?: { principal: AuthContext["principal"]; scopeId?: string };
    }
  >;
}
/** The owner's browser link on the Browser screen: extension connection and loopback pairings (cli/browser.ts). */
export interface BrowserLinkHost {
  status(): Record<string, unknown>;
  approve(id: string): Promise<boolean>;
  reject(id: string): boolean;
  forget(id: string): Promise<boolean>;
  /** Ask the connected extension to open its management page; false when it cannot. */
  manage(): boolean;
  select?(id?: string): boolean;
}
export interface ProductHost {
  stateDir: string;
  /** Absent or undefined: the browser bridge is turned off (browser.enabled: false) or not started. */
  browserLink?(): BrowserLinkHost | undefined;
  socialAccounts?: SocialAccountRuntime;
  /** Trusted composition lookup; unavailable until service initialization has completed. */
  publications?(): import("./publications/runtime.js").PublicationRuntime | undefined;
  secrets: SecretStore;
  privateFiles: PrivateFileProtection;
  core(): CrotCore;
  selectWorkspace(root: string): Promise<void>;
  /** Service-verified current entitlement; absent/offline cannot grant new unlimited registrations. */
  unlimitedProjects?(): Promise<boolean>;
  secretFiles?: { status(): Record<string, unknown>; set(input: unknown): Promise<Record<string, unknown>> };
  disconnectAgent?(id: string): Promise<void>;
  holdActivity?(work: () => Promise<unknown>): Promise<unknown>;
  tokens?: import("./client-tokens.js").ClientTokenRegistry;
  emergencyStop?(): Promise<Record<string, unknown>>;
  recordControlEvent?: (event: import("../core/audit/audit.js").ControlAuditRecord) => Promise<void>;
  /**
   * The owner's local OpenCode: key discovery (OPENCODE_API_KEY, auth.json) and the managed `opencode serve`
   * bridge. Absent: CROT neither reads OpenCode's files nor starts OpenCode.
   */
  openCode?: Omit<OpenCodeBridgeOptions, "directory" | "allowed" | "record" | "runtime" | "pidFile"> & {
    /** The binary check (and npm, the fallback) for "Install and start OpenCode"; absent: CROT never installs it. */
    install?: OpenCodeInstallHost;
  };
}
/** The emergency stop, or an explicit runtime deny of starting processes, also refuses the OpenCode bridge. */
function processDenied(core: CrotCore): boolean {
  if (core.permissions.runtime.halted) return true;
  return core.permissions.runtime.policy.rules.some(
    (r) =>
      r.state === "deny" &&
      (r.operation === "process.start" || r.capability === "process.manage" || r.capability === "shell.execute"),
  );
}
const fail = (message: string): never => {
  throw new CrotError("INVALID_INPUT", message);
};
/** The normalized base URL of a custom profile; undefined when it has none or it is malformed. */
const serverOf = (endpoint?: string): string | undefined => {
  if (!endpoint) return undefined;
  try {
    return chatEndpoint(endpoint);
  } catch {
    return undefined;
  }
};
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const now = () => new Date().toISOString();
const strings = (v: unknown) => v as string[];
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const limited = <T>(values: T[], limit = 500): T[] => values.slice(-limit);
export const productPaths = (dir: string) => [
  path.join(dir, "product-state.json"),
  path.join(dir, "product-vault.enc"),
  path.join(dir, "oauth-secret-store.json"),
  path.join(dir, "social-accounts.json"),
  path.join(dir, "publications.json"),
];

class PipeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = new ReadBuffer();
  private pendingBytes = 0;
  constructor(private proc: ManagedProcess) {}
  async start(): Promise<void> {
    this.proc.stdout.on("data", (chunk: Buffer) => {
      try {
        this.pendingBytes += chunk.length;
        if (this.pendingBytes > 2 * 1024 * 1024) throw new Error("MCP frame too large");
        this.buffer.append(chunk);
        let msg;
        while ((msg = this.buffer.readMessage()) !== null) {
          this.onmessage?.(msg);
          this.pendingBytes = 0;
        }
      } catch {
        this.onerror?.(new Error("Invalid MCP transport frame"));
        void this.close();
      }
    });
    this.proc.stderr.resume(); // Never persist untrusted stderr: it can contain credentials.
    void this.proc.exited.then(() => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.proc.stdin || this.proc.hasExited) throw new Error("MCP process closed");
    const line = serializeMessage(message);
    await new Promise<void>((resolve, reject) => this.proc.stdin!.write(line, (e) => (e ? reject(e) : resolve())));
  }
  async close(): Promise<void> {
    await this.proc.terminate("force");
  }
}

export class ProductRuntime {
  private state!: State;
  private appliedTabPolicy: BrowserTabPolicy | undefined;
  private vault: Vault = { credentials: {}, replays: {} };
  private key!: Buffer;
  private writes: Promise<void> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private operationContext = new AsyncLocalStorage<AuthContext>();
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Record<string, unknown>>>();
  private serverControllers = new Map<string, AbortController>();
  private agentClosers = new Map<string, () => Promise<void>>();
  attachAgent(id: string, close: () => Promise<void>): void {
    this.agentClosers.set(id, close);
  }
  detachAgent(id: string): void {
    this.agentClosers.delete(id);
    const a = this.state.agents.find((a) => a.id === id);
    if (a) a.connected = false;
    void this.persist().catch(() => undefined);
  }
  private cancellations = new Map<string, AbortController>();
  private contexts = new Map<string, AuthContext>();
  private rate = new Map<string, number[]>();
  private poller: NodeJS.Timeout | undefined;
  private schemaValidator = new AjvJsonSchemaValidator();
  private readonly chat: ChatRuntime;
  /** CROT's local OpenCode server (`opencode serve`), when the host enables local OpenCode. */
  private readonly openCode: OpenCodeBridge | undefined;
  /** OpenCode installed by CROT into <stateDir>/opencode-runtime, when the host can run npm. */
  private readonly runtime: OpenCodeRuntime | undefined;
  private readonly avatars = new AccountAvatars();
  private constructor(private host: ProductHost) {
    const openCode = host.openCode;
    const allowed = () => !processDenied(this.host.core());
    this.runtime = openCode?.install
      ? new OpenCodeRuntime({
          directory: path.join(host.stateDir, "opencode-runtime"),
          platform: openCode.local.platform,
          arch: process.arch,
          host: openCode.install,
          allowed,
          record: (outcome, reason) =>
            void this.host
              .recordControlEvent?.({
                kind: "control",
                id: newAuditEventId(),
                timestamp: now(),
                action: "opencode_runtime",
                actor: { channel: "control" },
                outcome,
                value: "install",
                ...(reason ? { reason } : {}),
              })
              .catch(() => undefined),
        })
      : undefined;
    this.openCode = openCode
      ? new OpenCodeBridge({
          ...openCode,
          directory: path.join(host.stateDir, "opencode-chat"),
          ...(this.runtime ? { runtime: this.runtime } : {}),
          pidFile: path.join(host.stateDir, "opencode-bridge.pid"),
          allowed,
          record: (event, outcome) =>
            void this.host
              .recordControlEvent?.({
                kind: "control",
                id: newAuditEventId(),
                timestamp: now(),
                action: "opencode_bridge",
                actor: { channel: "control" },
                outcome,
                value: event,
              })
              .catch(() => undefined),
        })
      : undefined;
    const bridge = this.openCode;
    this.chat = new ChatRuntime({
      ...(openCode && bridge ? { openCode: { key: () => findOpenCodeKey(openCode.local), bridge } } : {}),
      core: () => this.host.core(),
      configuration: (provider) => this.state.chatProviders?.[provider],
      credential: (provider) => this.vault.credentials[`chat:${provider}`],
      configured: () => Object.keys(this.state?.chatProviders ?? {}) as ChatProvider[],
      project: () => {
        const active = this.state?.projects.find((p) => p.id === this.state.active);
        return active ? { name: active.name, root: this.host.core().workspace.root } : undefined;
      },
      context: () => this.context(),
      run: (context, work) => {
        const run = async () => {
          try {
            return await this.execute("$chat", "generate", [context], (args) => work(args[0] as AuthContext));
          } finally {
            this.detachAgent(this.agentId(context));
          }
        };
        return this.host.holdActivity ? this.host.holdActivity(run) : run();
      },
    });
  }
  static async open(host: ProductHost): Promise<ProductRuntime> {
    const r = new ProductRuntime(host);
    r.key = Buffer.from(await host.secrets.readOrCreate("product-key"), "base64url");
    const file = productPaths(host.stateDir)[0]!;
    const meta = await readFile(file, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
    if (meta && meta.length > 8 * 1024 * 1024) fail("Product state is too large");
    r.state = meta
      ? (JSON.parse(meta) as State)
      : { version: 1, active: "", projects: [], agents: [], connectors: [], servers: [], tasks: [] };
    if (r.state.version !== 1 || !Array.isArray(r.state.projects) || !Array.isArray(r.state.tasks))
      fail("Invalid product state; restore service state");
    if (r.state.browserPolicyPrevious) {
      r.state.browserPolicy = r.state.browserPolicyPrevious;
      delete r.state.browserPolicyPrevious;
    }
    if (r.state.browserAccess !== undefined && !parseProduct("browser.access.set", r.state.browserAccess))
      fail("Invalid browser access state; restore service state");
    if (r.state.browserAccessPrevious != null && !parseProduct("browser.access.set", r.state.browserAccessPrevious))
      fail("Invalid previous browser access state; restore service state");
    if (r.state.browserAccessPrevious !== undefined) {
      if (r.state.browserAccessPrevious === null) delete r.state.browserAccess;
      else r.state.browserAccess = r.state.browserAccessPrevious;
      delete r.state.browserAccessPrevious;
    }
    r.appliedTabPolicy = r.state.browserPolicy;
    if (r.state.securityPrevious) {
      host.core().permissions.runtime.replace(r.state.securityPrevious);
      r.state.security = host.core().permissions.runtime.policy;
      delete r.state.securityPrevious;
    } else if (r.state.security) host.core().permissions.runtime.replace(r.state.security);
    const encrypted = await readFile(productPaths(host.stateDir)[1]!, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
    if (encrypted) {
      const value = JSON.parse(encrypted) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", r.key, Buffer.from(value.iv, "base64"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      r.vault = JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString(),
      ) as Vault;
    }
    for (const t of r.state.tasks)
      if (t.state === "Running") {
        t.state = "Interrupted";
        t.endedAt = now();
      }
    for (const a of r.state.agents) a.connected = false;
    for (const s of r.state.servers) s.status = "Disconnected";
    const root = await realpath(host.core().workspace.root);
    if (!r.state.projects.some((p) => p.path === root)) {
      await r.assertProjectAdmission();
      r.state.projects.push(r.newProject(root));
    }
    // An explicit CLI/config workspace change wins over the last UI selection.
    // Restarts with the same launch root restore the selected project.
    if (!r.state.active || (r.state.launchWorkspace && r.state.launchWorkspace !== root))
      r.state.active = r.state.projects.find((p) => p.path === root)!.id;
    r.state.launchWorkspace = root;
    const active = r.state.projects.find((p) => p.id === r.state.active);
    if (!active) fail("Active project is missing from the registry");
    if (active && active.path !== root) await host.selectWorkspace(active.path);
    if (host.browserLink?.()) {
      r.appliedTabPolicy = r.state.browserPolicy ?? host.core().browser.getTabPolicy();
      host.core().browser.setTabPolicy(r.appliedTabPolicy);
      if (r.state.browserAccess)
        host.core().permissions.runtime.setBrowserAccess({
          ...r.state.browserAccess,
          sessions: !r.appliedTabPolicy.sensitivePreset,
        });
      else await r.applyBrowserAccess({ read: true, navigation: true });
    } else {
      host.core().permissions.runtime.setBrowserAccess(undefined);
      if (r.state.browserPolicy) host.core().browser.setTabPolicy(r.state.browserPolicy);
    }
    r.migrateChatProviders();
    // Pre-allow network hosts for all saved provider configurations so that
    // chat.models / chat.generate do not hit NETWORK_GUARD_BLOCKED on restart.
    {
      const hostsToAllow = new Set<string>();
      for (const [provider, config] of Object.entries(r.state.chatProviders ?? {}))
        for (const h of providerNetworkHosts(provider as ChatProvider, config?.endpoint)) hostsToAllow.add(h);
      if (hostsToAllow.size) host.core().addNetworkAllow([...hostsToAllow]);
    }
    await r.persist();
    r.poller = setInterval(() => void r.pollProcesses().catch(() => undefined), 1200);
    r.poller.unref();
    // An OpenCode server that a killed or crashed CROT left running (its PID file) stops now.
    void r.openCode?.reap();
    return r;
  }
  get activeProject(): Project {
    return this.state.projects.find((p) => p.id === this.state.active)!;
  }
  /**
   * Saved chat providers on open: a legacy single custom configuration ("Custom API",
   * "OpenAI-compatible", "River") moves to a named profile ("Custom API:river") together with
   * its credential, and profiles of the same server merge into one (mergeDuplicateProfiles).
   * Nothing else is changed or removed; an entry whose endpoint cannot be migrated stays as it is.
   */
  private migrateChatProviders(): void {
    const saved = this.state.chatProviders as Record<string, ChatProviderConfig | undefined> | undefined;
    if (!saved) return;
    const credentials = this.vault.credentials;
    for (const key of Object.keys(saved)) {
      const config = saved[key];
      const family: CustomProviderFamily | undefined =
        key === "River" ? "OpenAI-compatible" : key === "Custom API" || key === "OpenAI-compatible" ? key : undefined;
      if (!family || !config || typeof config.endpoint !== "string") continue;
      let endpoint: string;
      try {
        endpoint = chatEndpoint(config.endpoint || (key === "River" ? "https://api.river.ai/v1" : ""));
      } catch {
        continue;
      }
      let profile: ChatProvider;
      try {
        profile = this.customProfile(family, endpoint);
      } catch {
        continue; // Profile limit reached: keep the legacy entry.
      }
      const credential = credentials[`chat:${key}`];
      if (saved[profile]) {
        // This server already has a profile: it stays, taking the legacy credential only if it has none.
        if (credential !== undefined && credentials[`chat:${profile}`] === undefined)
          credentials[`chat:${profile}`] = credential;
      } else {
        saved[profile] = {
          ...config,
          endpoint,
          label: this.profileLabel(profile, config.label ?? (key === "River" ? "River" : customLabel(endpoint))),
        };
        if (credential !== undefined) credentials[`chat:${profile}`] = credential;
      }
      delete saved[key];
      delete credentials[`chat:${key}`];
    }
    this.mergeDuplicateProfiles();
  }
  /** The custom profiles (either family) saved for this server. */
  private sameServerProfiles(endpoint: string): ChatProvider[] {
    const saved = this.state.chatProviders ?? {};
    const server = serverOf(endpoint);
    if (server === undefined) return [];
    return (Object.keys(saved) as ChatProvider[]).filter(
      (k) => isProfileKey(k) && isCustomFamily(k) && serverOf(saved[k]?.endpoint) === server,
    );
  }
  /**
   * One profile per server. Older versions kept one profile per custom family, so the same URL could
   * be saved twice ("River" and "River 2"): such profiles merge into one, preferably a "Custom API"
   * key, with the most recently verified configuration, a credential whenever one of them had one,
   * and the original name. Profiles of other servers are not touched.
   */
  private mergeDuplicateProfiles(): void {
    const saved = this.state.chatProviders as Record<string, ChatProviderConfig | undefined> | undefined;
    if (!saved) return;
    const credentials = this.vault.credentials;
    const groups = new Map<string, ChatProvider[]>();
    for (const key of Object.keys(saved) as ChatProvider[]) {
      if (!isProfileKey(key) || !isCustomFamily(key)) continue;
      const server = serverOf(saved[key]?.endpoint);
      if (server !== undefined) groups.set(server, [...(groups.get(server) ?? []), key]);
    }
    for (const [server, keys] of groups) {
      if (keys.length < 2) continue;
      const score = (k: ChatProvider): number[] => [
        credentials[`chat:${k}`] !== undefined ? 1 : 0,
        saved[k]?.connectionStatus === "connected" ? 1 : 0,
        Date.parse(saved[k]?.checkedAt ?? "") || 0,
        baseProvider(k) === "Custom API" ? 1 : 0,
      ];
      const rank = (a: ChatProvider, b: ChatProvider): number => {
        const x = score(a),
          y = score(b);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
        return 0;
      };
      const ranked = [...keys].sort(rank);
      const best = ranked[0]!;
      const keep = ranked.find((k) => baseProvider(k) === "Custom API") ?? best;
      // The original name, not a numbered copy of another one in the group ("River", not "River 2").
      const labels = ranked.map((k) => saved[k]?.label).filter((l): l is string => typeof l === "string" && l !== "");
      const label =
        labels.find(
          (l) => !labels.some((other) => other !== l && new RegExp(`^${escapeRegExp(other)} \\d+$`).test(l)),
        ) ?? customLabel(server);
      const config: ChatProviderConfig = { ...saved[best]!, endpoint: server };
      // An OpenAI-compatible profile always spoke the OpenAI protocol, the default of a Custom API profile.
      if (baseProvider(best) === "OpenAI-compatible") delete config.protocol;
      const credential = ranked.map((k) => credentials[`chat:${k}`]).find((v) => v !== undefined);
      for (const k of keys) {
        delete saved[k];
        delete credentials[`chat:${k}`];
      }
      saved[keep] = config;
      if (credential !== undefined) credentials[`chat:${keep}`] = credential;
      config.label = this.profileLabel(keep, label);
    }
  }
  /**
   * The profile a custom server is saved as: the existing one for this endpoint (of either custom
   * family, so a legacy "OpenAI-compatible" request updates "Custom API:river"), else a new key.
   */
  private customProfile(family: CustomProviderFamily, endpoint: string): ChatProvider {
    const saved = this.state.chatProviders ?? {};
    const keys = Object.keys(saved) as ChatProvider[];
    const same = this.sameServerProfiles(endpoint);
    const match = same.find((k) => baseProvider(k) === family) ?? same[0];
    if (match) return match;
    if (keys.filter((k) => isProfileKey(k)).length >= 16) fail("Custom provider limit reached; remove one first");
    const slug = customSlug(endpoint);
    for (let n = 1; ; n++) {
      const key = `${family}:${n === 1 ? slug : `${slug}-${n}`}` as ChatProvider;
      if (!saved[key]) return key;
    }
  }
  /** A display name that no other custom profile uses ("River", "River 2"). */
  private profileLabel(provider: ChatProvider, wanted: string): string {
    const taken = new Set(
      Object.entries(this.state.chatProviders ?? {})
        .filter(([k, c]) => k !== provider && isProfileKey(k as ChatProvider) && c?.label)
        .map(([, c]) => c!.label!.toLowerCase()),
    );
    let label = wanted.slice(0, 64);
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${wanted.slice(0, 60)} ${n}`;
    return label;
  }
  /** A bare custom family names its only saved profile; with several the caller must choose one. */
  private chatKey(provider: ChatProvider): ChatProvider {
    if (!isCustomFamily(provider) || isProfileKey(provider) || this.state.chatProviders?.[provider]) return provider;
    const profiles = Object.keys(this.state.chatProviders ?? {}).filter((k) => k.startsWith(`${provider}:`));
    if (profiles.length > 1) fail("Choose which saved custom provider to use");
    return (profiles[0] as ChatProvider | undefined) ?? provider;
  }
  private async assertProjectAdmission(): Promise<void> {
    if (this.state.projects.length < PLAN_CATALOG.free.advertisedProjects) return;
    if (await this.host.unlimitedProjects?.()) return;
    fail(
      "Free supports up to 3 registered projects. A current verified Pro entitlement is required to add more; existing projects and L1 remain available.",
    );
  }
  private newProject(root: string, name?: string): Project {
    return {
      id: randomUUID(),
      path: root,
      name: name ?? path.basename(root),
      favorite: false,
      lastOpened: now(),
      tools: [],
      agents: [],
      connectors: [],
    };
  }
  private context(signal?: AbortSignal): AuthContext {
    return (
      this.operationContext.getStore() ?? { principal: localPrincipal("owner-product"), ...(signal ? { signal } : {}) }
    );
  }
  private persist(): Promise<void> {
    const live = new Set(this.state.tasks.map((t) => t.id));
    for (const id of Object.keys(this.vault.replays))
      if (!live.has(id)) {
        delete this.vault.replays[id];
        this.contexts.delete(id);
      }
    let replayBytes = 0;
    for (const task of this.state.tasks.slice().reverse()) {
      const replay = this.vault.replays[task.id];
      if (!replay) continue;
      replayBytes += Buffer.byteLength(JSON.stringify(replay));
      if (replayBytes > 8 * 1024 * 1024) {
        delete this.vault.replays[task.id];
        task.retryable = false;
      }
    }
    const metadata = JSON.stringify(this.state);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.vault)), cipher.final()]);
    const vault = JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    });
    const work = async () => {
      await writePrivateFileAtomic(productPaths(this.host.stateDir)[1]!, vault, this.host.privateFiles);
      await writePrivateFileAtomic(productPaths(this.host.stateDir)[0]!, metadata, this.host.privateFiles);
    };
    this.writes = this.writes.then(work, work);
    return this.writes;
  }
  private async event(type: string, project = this.state.active, agent = "owner"): Promise<void> {
    const audit = this.host.core().status().audit;
    if (!audit.path) return;
    // Audit writer belongs to Core. Administrative event includes only bounded identifiers.
    await this.host
      .core()
      .guard.run(
        this.context(),
        { operation: type, capability: [], details: { project, agent } },
        async () => undefined,
      );
  }
  endOwnerSession(owner: object): void {
    this.host.publications?.()?.endOwnerSession(owner);
  }
  async request(method: ProductMethod, input: unknown, owner?: object): Promise<Record<string, unknown>> {
    const params = parseProduct(method, input);
    if (!params) fail("Invalid product request");
    if (method.startsWith("publications.")) {
      const runtime = this.host.publications?.();
      if (!runtime || !owner)
        throw new CrotError("PERMISSION_DENIED", "Authenticated publication owner session unavailable");
      const id = String(params!.id ?? "");
      switch (method) {
        case "publications.prepare":
          return {
            ok: true,
            publication: await this.host.core().publications.preparePublication(this.context(), params),
          };
        case "publications.list":
          return runtime.list(owner);
        case "publications.open":
          return runtime.openForOwner(owner, id);
        case "publications.preview":
          return runtime.preview(owner, params);
        case "publications.confirm":
          return runtime.confirm(owner, params);
        case "publications.cancel":
          return runtime.cancel(owner, id);
      }
    }
    if (method === "security.kill") {
      if (!this.host.emergencyStop) fail("Emergency stop unavailable in this host");
      return this.host.emergencyStop!();
    }
    const run = () =>
      [
        "projects.syncWorkspaceArtifacts",
        "skills.test",
        "skills.run",
        "system.check",
        "onboarding.advance",
        "connectors.testConnection",
        "mcpServers.connect",
        "mcpServers.callTool",
      ].includes(method)
        ? (this.execute("$product", method, [this.context(), params], (a) =>
            this.operationContext.run(a[0] as AuthContext, () => this.dispatch(method, params!)),
          ) as Promise<Record<string, unknown>>)
        : this.dispatch(method, params!);
    // Reads and long operations must not hold up cancellations/approval traffic.
    if (
      method === "onboarding.advance" ||
      method === "skills.test" ||
      method === "skills.run" ||
      method === "system.check" ||
      method === "projects.syncWorkspaceArtifacts" ||
      method === "projects.inspect" ||
      method === "security.status" ||
      method === "browser.link.status" ||
      method === "browser.link.manage" ||
      (method.startsWith("chat.") && method !== "chat.configure") ||
      method.startsWith("opencode.") ||
      method.startsWith("tokens.") ||
      method.startsWith("accounts.") ||
      method.endsWith(".list") ||
      method.startsWith("monitoring.") ||
      method === "connectors.testConnection" ||
      method === "mcpServers.connect" ||
      method === "mcpServers.callTool" ||
      method.startsWith("tasks.")
    )
      return run();
    const next = this.mutations.then(run, run);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  /** Only control-center passes a broker-bound subject and a synchronous one-time decision. */
  approveProject(
    subject: import("../core/approvals/types.js").ApprovalSubject,
    approveOnce: () => boolean,
  ): Promise<Record<string, unknown>> {
    const run = async () => {
      const runtime = this.host.core().permissions.runtime,
        policy = runtime.policy;
      if (
        runtime.halted ||
        policy.strict ||
        subject.rule !== "runtime.ask" ||
        subject.paths.some((p) => !p.insideWorkspace) ||
        !subject.workspace ||
        subject.workspace !== this.activeProject.path
      )
        fail("Only a current runtime ask can be remembered for this project; Strict Mode and mandatory gates cannot");
      const grant = { workspace: subject.workspace, operation: subject.operation };
      const grants = policy.projectGrants ?? [];
      const next = {
        ...policy,
        projectGrants: grants.some((g) => g.workspace === grant.workspace && g.operation === grant.operation)
          ? grants
          : [...grants, grant],
      };
      return this.applyRuntimePolicy(next, () => {
        if (!approveOnce()) fail("Approval is no longer pending or its digest changed");
      });
    };
    const next = this.mutations.then(run, run);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  private async applyRuntimePolicy(input: unknown, beforeCommit?: () => void): Promise<Record<string, unknown>> {
    if (!this.host.recordControlEvent) fail("Security policy audit unavailable");
    const runtime = this.host.core().permissions.runtime;
    const next = RuntimePolicySchema.parse(input),
      previous = runtime.policy;
    // Persist and audit before publishing a widening. No agent can observe an unaudited grant.
    this.state.securityPrevious = previous;
    this.state.security = next;
    try {
      await this.persist();
      await this.host.recordControlEvent!({
        kind: "control",
        id: newAuditEventId(),
        timestamp: now(),
        action: "runtime_policy",
        actor: { channel: "control" },
        outcome: "applied",
        previous: JSON.stringify(previous),
        value: JSON.stringify(next),
      });
      // Only the post-audit atomic snapshot commits the policy for a later restart.
      beforeCommit?.();
      delete this.state.securityPrevious;
      await this.persist();
    } catch (error) {
      this.state.security = previous;
      delete this.state.securityPrevious;
      try {
        await this.persist();
      } catch {
        runtime.stop();
      }
      throw error;
    }
    runtime.replace(next);
    return { ok: true, halted: runtime.halted, policy: runtime.policy };
  }
  /** Owner-only, audited product grant. It never bypasses token scopes, Core denies or approval gates. */
  private async applyBrowserAccess(next: { read: boolean; navigation: boolean }): Promise<Record<string, unknown>> {
    if (!this.host.browserLink?.()) return fail("Browser connection is unavailable");
    if (!this.host.recordControlEvent) return fail("Security policy audit unavailable");
    const previous = this.state.browserAccess;
    this.state.browserAccessPrevious = previous ?? null;
    this.state.browserAccess = next;
    try {
      await this.persist();
      await this.host.recordControlEvent({
        kind: "control",
        id: newAuditEventId(),
        timestamp: now(),
        action: "runtime_policy",
        actor: { channel: "control" },
        outcome: "applied",
        previous: JSON.stringify({ browserAccess: previous ?? null }),
        value: JSON.stringify({ browserAccess: next }),
      });
      delete this.state.browserAccessPrevious;
      await this.persist();
    } catch (error) {
      if (previous) this.state.browserAccess = previous;
      else delete this.state.browserAccess;
      delete this.state.browserAccessPrevious;
      try {
        await this.persist();
      } catch {
        this.host.core().permissions.runtime.stop();
      }
      throw error;
    }
    this.host.core().permissions.runtime.setBrowserAccess({
      ...next,
      sessions: !(this.appliedTabPolicy ?? this.host.core().browser.getTabPolicy()).sensitivePreset,
    });
    return { ok: true, access: next };
  }
  private async dispatch(method: ProductMethod, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(p.id ?? "");
    if (method.startsWith("accounts.")) {
      const social = this.host.socialAccounts;
      if (!social) return fail("Social account runtime unavailable");
      const provider = p.provider as SocialProvider;
      switch (method) {
        case "accounts.list":
          return social.list();
        case "accounts.avatar": {
          const account = social.list().accounts.find((a) => a.provider === provider);
          if (!account || (p.accountId && (p.accountId !== account.id || p.generation !== account.generation)))
            return { ok: true };
          const result = await this.avatars.get(account);
          const current = social.list().accounts.find((a) => a.provider === provider);
          return current?.generation === account.generation && current.state === account.state ? result : { ok: true };
        }
        case "accounts.configure":
          return social.configure(provider, String(p.clientId), p.clientSecret as string | undefined);
        case "accounts.connect":
          return social.connect(provider);
        case "accounts.check":
          return social.check(provider);
        case "accounts.cancel":
          return social.cancel(provider);
        case "accounts.disconnect":
          this.avatars.clear();
          {
            const accountId = social.list().accounts.find((a) => a.provider === provider)?.id;
            if (accountId) this.host.publications?.()?.abortAccount(accountId);
          }
          return social.disconnect(provider);
      }
    }
    switch (method) {
      case "browser.policy.get":
        return {
          ok: true,
          policy: this.appliedTabPolicy ?? this.host.core().browser.getTabPolicy(),
          access: this.host.core().permissions.runtime.browserAccess ?? null,
        };
      case "browser.access.set":
        return this.applyBrowserAccess({ read: p.read === true, navigation: p.navigation === true });
      case "browser.link.status":
        return { ok: true, link: this.host.browserLink?.()?.status() ?? { state: "disabled" } };
      case "browser.link.manage":
        return { ok: this.host.browserLink?.()?.manage() === true };
      case "browser.link.select": {
        const link = this.host.browserLink?.();
        if (!link?.select) return fail("Browser selection is unavailable");
        await this.event(method);
        if (!link.select(typeof p.id === "string" ? p.id : undefined))
          return fail("Browser connection no longer exists");
        return { ok: true, link: link.status() };
      }
      case "browser.link.approve":
      case "browser.link.reject":
      case "browser.link.forget": {
        const link = this.host.browserLink?.();
        if (!link) return fail("The browser connection is turned off");
        const pairing = String(p.id);
        // Owner decisions about which browser may connect are audited before they take effect.
        await this.event(method);
        const done =
          method === "browser.link.approve"
            ? await link.approve(pairing)
            : method === "browser.link.reject"
              ? link.reject(pairing)
              : await link.forget(pairing);
        if (!done) return fail("This connection request is no longer available");
        return { ok: true, link: link.status() };
      }
      case "browser.policy.set": {
        const next = parseTabPolicy(p),
          previous = this.appliedTabPolicy ?? this.host.core().browser.getTabPolicy();
        const oldAccess = this.state.browserAccess;
        const modeChanged = next.mode !== previous.mode || next.activeTab !== previous.activeTab;
        const automationEnabled = previous.automation === false && next.automation !== false;
        const nextAccess =
          oldAccess && (modeChanged || automationEnabled)
            ? { read: true, navigation: modeChanged ? true : oldAccess.navigation }
            : oldAccess;
        this.state.browserPolicyPrevious = previous;
        this.state.browserPolicy = next;
        if (nextAccess && oldAccess && JSON.stringify(nextAccess) !== JSON.stringify(oldAccess)) {
          this.state.browserAccessPrevious = oldAccess;
          this.state.browserAccess = nextAccess;
        }
        try {
          await this.persist();
          await this.event(method);
          if (this.state.browserAccessPrevious) {
            if (!this.host.recordControlEvent) fail("Security policy audit unavailable");
            await this.host.recordControlEvent!({
              kind: "control",
              id: newAuditEventId(),
              timestamp: now(),
              action: "runtime_policy",
              actor: { channel: "control" },
              outcome: "applied",
              previous: JSON.stringify({ browserAccess: oldAccess }),
              value: JSON.stringify({ browserAccess: nextAccess }),
            });
          }
          delete this.state.browserPolicyPrevious;
          delete this.state.browserAccessPrevious;
          await this.persist();
        } catch (error) {
          this.state.browserPolicy = previous;
          if (oldAccess) this.state.browserAccess = oldAccess;
          delete this.state.browserPolicyPrevious;
          delete this.state.browserAccessPrevious;
          try {
            await this.persist();
          } catch {
            this.host.core().permissions.runtime.stop();
          }
          throw error;
        }
        this.host.core().browser.setTabPolicy(next);
        if (nextAccess)
          this.host.core().permissions.runtime.setBrowserAccess({ ...nextAccess, sessions: !next.sensitivePreset });
        this.appliedTabPolicy = next;
        return { ok: true, policy: next, access: nextAccess ?? null };
      }
      case "chat.testConnection": {
        const provider = this.chatKey(p.provider as ChatProvider);
        const config = this.state.chatProviders?.[provider];
        if (!config) return fail("Configure the chat provider first");
        try {
          const result = await this.chat.models(provider);
          const models = result.models as string[];
          if (!models.length)
            throw new CrotError("OPERATION_FAILED", "Provider returned no usable models", {
              stage: "inventory",
              reason: "no_models",
            });
          // The saved model while the live inventory still has it, else the first free one (OpenCode's default
          // first), else the first model.
          const free = Array.isArray(result.free) ? (result.free as string[]) : [];
          const model =
            config.defaultModel && models.includes(config.defaultModel)
              ? config.defaultModel
              : (models.find((m) => free.includes(m)) ?? models[0]!);
          // OpenCode Zen through local OpenCode: one tiny request with that model. Its refusal (a free tier limit,
          // a model OpenCode rejects) is reported with the connection, never instead of it.
          const check = await this.chat.verify(provider, model);
          if (this.state.chatProviders?.[provider] !== config)
            return fail("Provider configuration changed; test again");
          config.checkedAt = now();
          config.connectionStatus = "connected";
          delete config.connectionError;
          config.defaultModel = model;
          if (check) config.modelCheck = check;
          else delete config.modelCheck;
          // OpenCode (Free & Zen): the route and key source of this check (never the key).
          if (result.route === "zen" || result.route === "local") config.route = result.route;
          else delete config.route;
          if (typeof result.keySource === "string")
            config.keySource = result.keySource as ChatProviderConfig["keySource"];
          else delete config.keySource;
          await this.persist();
          await this.event(method, undefined, provider);
          return {
            ...result,
            provider,
            checkedAt: config.checkedAt,
            defaultModel: config.defaultModel,
            ...(check ? { modelCheck: check } : {}),
          };
        } catch (error) {
          const diagnostic = providerDiagnostic(error);
          if (this.state.chatProviders?.[provider] === config) {
            config.connectionError = diagnostic;
            config.checkedAt = now();
            config.connectionStatus = "failed";
            delete config.route;
            delete config.keySource;
            delete config.modelCheck;
            await this.persist();
          }
          // OpenCode: whether the CLI is installed, so the owner sees how to get a key or install it.
          const openCode =
            baseProvider(provider) === "OpenCode (Free & Zen)" || provider === "OpenCode"
              ? await this.openCodeStatus().catch(() => undefined)
              : undefined;
          return {
            ok: false,
            provider,
            message: "Provider check failed",
            diagnostic,
            ...(openCode ? { openCode } : {}),
          };
        }
      }
      case "skills.list":
        return { ok: true, skills: this.state.skills ?? [] };
      case "skills.create": {
        const skill = SkillSchema.parse(p);
        if ((this.state.skills ?? []).length >= 64 && !(this.state.skills ?? []).some((s) => s.id === skill.id))
          fail("Skill limit reached");
        this.state.skills = [...(this.state.skills ?? []).filter((s) => s.id !== skill.id), skill];
        await this.persist();
        await this.event(method, undefined, skill.id);
        return { ok: true, skill };
      }
      case "skills.remove":
        this.state.skills = (this.state.skills ?? []).filter((s) => s.id !== p.id);
        await this.persist();
        await this.event(method, undefined, String(p.id));
        return { ok: true };
      case "skills.test":
      case "skills.run": {
        const skill = (this.state.skills ?? []).find((s) => s.id === p.id) ?? fail("Unknown skill");
        // No shell interpolation. Each placeholder stays one literal argv entry.
        const values = object(p.values);
        const args =
          method === "skills.test"
            ? ["--version"]
            : skill.args.map((a) =>
                a.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, k: string) =>
                  typeof values[k] === "string" ? String(values[k]) : fail("Missing skill argument: " + k),
                ),
              );
        const result = await this.host
          .core()
          .processes.execInScratch(
            this.context(),
            { command: skill.command, args, cwd: this.activeProject.path },
            skill.workingDirectory,
          );
        return { ok: result.exitCode === 0, result };
      }
      case "onboarding.status":
        return { ok: true, onboarding: this.state.onboarding ?? { completedStep: 0 }, project: this.activeProject };
      case "onboarding.advance": {
        const step = Number(p.step),
          previous = this.state.onboarding?.completedStep ?? 0;
        if (step !== previous + 1 || step > 4) fail("Complete first-run steps in order");
        if (step === 4)
          await this.host
            .core()
            .guard.run(this.context(), { operation: "onboarding.ping", capability: [] }, async () =>
              this.host.core().filesystem.stat(this.context(), { path: "." }),
            );
        this.state.onboarding = { completedStep: step, updatedAt: now() };
        await this.persist();
        await this.event(method);
        return { ok: true, onboarding: this.state.onboarding };
      }
      case "system.check": {
        const core = this.host.core();
        const l1 = await core.refreshConfinement().catch(() => ({
          ...core.confinementStatus(),
          available: false,
          reason: "self_test_failed" as const,
          detail: "Native L1 readiness refresh failed; no unconfined retry",
        }));
        const ports = await checkLoopbackPort();
        const inspection = await core.inspectProject(this.context());
        return {
          ok: true,
          report: {
            generatedAt: now(),
            node: { version: process.version, platform: process.platform, arch: process.arch },
            l1,
            ports,
            bridge: core.status().browser,
            project: inspection,
            accounts: this.host.socialAccounts?.list().accounts.map((account) => account.diagnostics) ?? [],
            publicationProtection: publicationProtection(l1),
            nativeCommandPrerequisiteMet: l1.available,
            detail: l1.available
              ? "Native L1 ready; permissions, approvals and halt state still apply"
              : "Commands refused: install/repair native L1; no unconfined retry",
          },
        };
      }
      case "chat.providers":
        return {
          ok: true,
          providers: this.chat.providers(),
          current: this.chat.current,
          thread: this.chat.currentThread,
        };
      case "chat.reset":
        return this.chat.reset(typeof p.thread === "string" ? p.thread : undefined);
      case "chat.remove": {
        if (this.chat.running) return fail("Stop generation before removing a provider");
        const provider = this.chatKey(p.provider as ChatProvider);
        await this.event(method, undefined, provider);
        delete this.state.chatProviders?.[provider];
        delete this.vault.credentials[`chat:${provider}`];
        await this.persist();
        // CROT's own OpenCode server goes when no provider uses it any more.
        if (!this.openCodeInUse()) await this.openCode?.stop();
        return { ok: true };
      }
      case "chat.configure": {
        if (this.chat.running) return fail("Stop generation before changing provider configuration");
        if (!this.host.recordControlEvent) return fail("Provider configuration audit unavailable");
        const requested = p.provider as ChatProvider;
        const endpoint = chatEndpoint(
          String(
            p.endpoint ??
              (isProfileKey(requested)
                ? (this.state.chatProviders?.[requested]?.endpoint ?? "")
                : CHAT_ENDPOINTS[baseProvider(requested)]),
          ),
        );
        // Each custom server is its own profile: a bare family key saves (or updates) the profile
        // of this endpoint, so a second server never replaces the first.
        const provider =
          isCustomFamily(requested) && !isProfileKey(requested)
            ? this.customProfile(baseProvider(requested) as CustomProviderFamily, endpoint)
            : requested;
        await this.host.recordControlEvent({
          kind: "control",
          id: newAuditEventId(),
          timestamp: now(),
          action: "chat_provider",
          actor: { channel: "control" },
          outcome: "applied",
          value: provider,
        });
        this.state.chatProviders ??= {};
        // One profile per server: a profile edited to another profile's URL takes that one over.
        if (isProfileKey(provider)) {
          const others = this.sameServerProfiles(endpoint).filter((k) => k !== provider);
          const credentials = this.vault.credentials;
          for (const other of others) {
            const credential = credentials[`chat:${other}`];
            if (p.credential === undefined && credentials[`chat:${provider}`] === undefined && credential !== undefined)
              credentials[`chat:${provider}`] = credential;
            delete this.state.chatProviders[other];
            delete credentials[`chat:${other}`];
          }
        }
        const previous = this.state.chatProviders[provider];
        this.state.chatProviders[provider] = {
          ...(previous?.endpoint === endpoint &&
          p.credential === undefined &&
          (p.username === undefined || previous.username === p.username)
            ? previous
            : {}),
          endpoint,
          ...(p.username !== undefined ? { username: String(p.username) } : {}),
          ...(p.defaultModel !== undefined ? { defaultModel: String(p.defaultModel) } : {}),
          ...(p.protocol !== undefined ? { protocol: p.protocol as "openai" | "anthropic" } : {}),
          ...(provider === "OpenCode" && p.managed !== undefined ? { managed: p.managed === true } : {}),
          ...(isProfileKey(provider)
            ? {
                label: this.profileLabel(
                  provider,
                  typeof p.label === "string"
                    ? p.label
                    : previous?.endpoint === endpoint && previous.label
                      ? previous.label
                      : customLabel(endpoint),
                ),
              }
            : {}),
        };
        if (p.credential !== undefined) this.vault.credentials[`chat:${provider}`] = String(p.credential);
        // A managed OpenCode server gets its own random password; an old server password is not kept.
        if (provider === "OpenCode" && p.managed === true) delete this.vault.credentials[`chat:${provider}`];
        await this.persist();
        // Auto-allow the provider's preset hosts and its (custom) endpoint host, port included.
        this.host.core().addNetworkAllow(providerNetworkHosts(provider, endpoint));
        return { ok: true, provider, providers: this.chat.providers(), current: this.chat.current };
      }
      case "chat.models":
        // Listing models never starts local OpenCode; Save & Test and the chat do.
        return this.chat.models(this.chatKey(p.provider as ChatProvider), { start: false });
      case "opencode.status":
        return { ok: true, ...(await this.openCodeStatus()) };
      case "opencode.install": {
        // "Install and start OpenCode": CROT downloads the pinned OpenCode in the background; the status
        // reports its progress, and the owner's next Save & Test starts it.
        if (!this.runtime) return fail("Installing OpenCode is unavailable in this host");
        await this.runtime.start();
        return { ok: true, ...(await this.openCodeStatus()) };
      }
      case "opencode.stop": {
        if (this.chat.running) return fail("Stop generation before stopping OpenCode");
        const stopped = (await this.openCode?.stop()) ?? false;
        return { ok: true, stopped, ...(await this.openCodeStatus()) };
      }
      case "chat.start":
        return this.chat.start({ ...p, provider: this.chatKey(p.provider as ChatProvider) });
      case "chat.poll":
        return this.chat.poll(id);
      case "chat.stop":
        return this.chat.stop(id);
      case "tokens.list":
        return { ok: true, tokens: this.host.tokens?.list() ?? [] };
      case "tokens.issue":
      case "tokens.rotate":
      case "tokens.revoke": {
        const tokens = this.host.tokens;
        if (!tokens) return fail("Client token registry unavailable");
        return method === "tokens.issue"
          ? tokens.issue(p)
          : method === "tokens.rotate"
            ? tokens.rotate(id)
            : tokens.revoke(id);
      }
      case "security.secretFiles.status":
        return this.host.secretFiles?.status() ?? { ok: false, message: "Owner secret-file controls unavailable" };
      case "security.secretFiles.set":
        if (!this.host.secretFiles) fail("Owner secret-file controls unavailable");
        return this.host.secretFiles!.set(p);
      case "security.status":
        return {
          ok: true,
          halted: this.host.core().permissions.runtime.halted,
          policy: this.host.core().permissions.runtime.policy,
        };
      case "security.kill":
        return fail("Emergency stop must use the unqueued owner path");
      case "security.setPolicy": {
        const policy = this.host.core().permissions.runtime.policy;
        return this.applyRuntimePolicy({
          ...p,
          ...(p.projectGrants === undefined && policy.projectGrants ? { projectGrants: policy.projectGrants } : {}),
        });
      }
      case "security.revokeProjectGrant": {
        const policy = this.host.core().permissions.runtime.policy;
        return this.applyRuntimePolicy({
          ...policy,
          projectGrants: (policy.projectGrants ?? []).filter(
            (g) => g.workspace !== p.workspace || g.operation !== p.operation,
          ),
        });
      }
      case "projects.inspect": {
        const work = () =>
          this.execute("$project", "inspect", [this.context()], (args) =>
            this.host.core().inspectProject(args[0] as AuthContext),
          );
        const inspection = this.host.holdActivity ? await this.host.holdActivity(work) : await work();
        return { ok: true, inspection };
      }
      case "projects.list":
        return { ok: true, projects: this.state.projects, active: this.state.active };
      case "projects.create":
      case "projects.open": {
        const input = String(p.path);
        if (!path.isAbsolute(input)) fail("Project path must be absolute");
        // Owner explicitly registers directories. No tool or agent can invoke this configuration RPC.
        if (method === "projects.create") {
          await this.assertProjectAdmission();
          await mkdir(input, { recursive: false, mode: 0o700 });
        }
        const root = await realpath(input);
        if (!(await stat(root)).isDirectory()) fail("Choose a directory");
        if (
          root === path.parse(root).root ||
          (productPaths(this.host.stateDir).some((f) => f.startsWith(root + path.sep)) && root === this.host.stateDir)
        )
          fail("Service state cannot be a project");
        let project = this.state.projects.find((v) => v.path === root);
        if (!project) {
          await this.assertProjectAdmission();
          project = this.newProject(root, p.name as string | undefined);
          this.state.projects.push(project);
        }
        await this.persist();
        await this.event(method, project.id);
        return { ok: true, project };
      }
      case "projects.select": {
        const project = this.state.projects.find((v) => v.id === id) ?? fail("Unknown project");
        await this.host.selectWorkspace(await realpath(project.path));
        if (this.appliedTabPolicy) this.host.core().browser.setTabPolicy(this.appliedTabPolicy);
        this.state.active = id;
        project.lastOpened = now();
        await this.persist();
        await this.event(method);
        return { ok: true, project };
      }
      case "projects.toggleFavorite":
      case "projects.updateSettings":
      case "projects.remove": {
        const project = this.state.projects.find((v) => v.id === id) ?? fail("Unknown project");
        if (method === "projects.toggleFavorite") project.favorite = !project.favorite;
        else if (method === "projects.remove") {
          if (this.state.active === id) fail("Select another project before removing the active project");
          this.state.projects = this.state.projects.filter((v) => v.id !== id);
        } else {
          project.tools = strings(p.tools);
          project.agents = strings(p.agents);
          project.connectors = strings(p.connectors);
        }
        await this.persist();
        await this.event(method, id);
        return { ok: true };
      }
      case "agents.list":
        return {
          ok: true,
          agents: this.state.agents.filter((a) => a.id !== "local:owner-product"),
          calls: this.state.tasks.map((t) => ({
            id: t.id,
            agent: t.agent,
            operation: t.operation,
            project: t.project,
            state: t.state,
            startedAt: t.startedAt,
          })),
        };
      case "agents.configure":
      case "agents.disconnect": {
        const a = this.state.agents.find((v) => v.id === id) ?? fail("Unknown agent");
        if (method === "agents.configure")
          Object.assign(a, {
            projects: p.projects,
            browser: p.browser,
            requestsPerMinute: p.requestsPerMinute,
            revoked: p.revoked,
          });
        else {
          a.revoked = true;
          a.connected = false;
          await this.agentClosers.get(id)?.();
          await this.host.disconnectAgent?.(id);
        }
        if (a.revoked)
          for (const task of this.state.tasks.filter((t) => t.agent === id && t.state === "Running"))
            await this.cancel(task);
        await this.persist();
        await this.event(method, undefined, id);
        return { ok: true };
      }
      case "projects.artifactStatus":
        return { ok: true, ...this.host.core().artifactStatus() };
      case "projects.syncWorkspaceArtifacts":
        return this.host.core().syncWorkspaceArtifacts(this.context(), p);
      case "connectors.list":
        return {
          ok: true,
          manifests: CONNECTOR_MANIFESTS,
          connectors: CONNECTOR_IDS.map(
            (id) =>
              this.state.connectors.find((c) => c.id === id) ?? {
                id,
                configured: false,
                enabled: false,
                scopes: [],
                projects: [],
                agents: [],
                status: "Available",
              },
          ),
        };
      case "connectors.configure": {
        if (!(CONNECTOR_IDS as readonly string[]).includes(id)) fail("Unknown connector");
        if (p.endpoint && id !== "Custom HTTP API") fail("Only Custom HTTP API accepts an endpoint");
        if (p.endpoint) {
          const u = new URL(String(p.endpoint));
          if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
            fail("Endpoint must be HTTP(S) without credentials, query or fragment");
        }
        if (p.credential) this.vault.credentials[id] = String(p.credential);
        const c: Connector = {
          id,
          configured: CONNECTOR_MANIFESTS.find((m) => m.id === id)?.kind === "local" || !!this.vault.credentials[id],
          enabled: true,
          scopes: strings(p.scopes),
          projects: strings(p.projects),
          agents: strings(p.agents),
          status: "Configured",
          ...(p.endpoint ? { endpoint: String(p.endpoint) } : {}),
        };
        if (!c.configured) fail("A credential is required");
        this.state.connectors = [...this.state.connectors.filter((v) => v.id !== id), c];
        await this.persist();
        await this.event(method);
        return { ok: true, connector: { ...c, mask: c.configured ? "••••••••" : "" } };
      }
      case "connectors.disconnect":
      case "connectors.revoke": {
        const c = this.state.connectors.find((v) => v.id === id) ?? fail("Unknown connector");
        c.enabled = false;
        c.status = "Disconnected";
        if (method === "connectors.revoke") {
          delete this.vault.credentials[id];
          c.configured = false;
          c.status = "Revoked";
        }
        await this.persist();
        await this.event(method);
        return { ok: true, connector: c };
      }
      case "connectors.testConnection":
        return this.testConnector(id);
      case "mcpServers.list":
        return { ok: true, servers: this.state.servers };
      case "mcpServers.add": {
        if ((p.transport === "stdio" && !p.command) || (p.transport === "http" && !p.url))
          fail("Transport address is required");
        if (p.url) {
          const u = new URL(String(p.url));
          if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
            fail("Invalid server URL");
        }
        const server: McpServer = {
          id: randomUUID(),
          name: String(p.name),
          transport: p.transport as McpServer["transport"],
          args: strings(p.args),
          status: "Disconnected",
          tools: [],
          resources: [],
          policy: {},
          logs: [],
          ...(p.command ? { command: String(p.command) } : {}),
          ...(p.url ? { url: String(p.url) } : {}),
        };
        if (p.token) this.vault.credentials[server.id] = String(p.token);
        this.state.servers.push(server);
        await this.persist();
        await this.event(method);
        return { ok: true, server };
      }
      case "mcpServers.connect":
        return this.connectServer(id);
      case "mcpServers.disconnect":
      case "mcpServers.remove": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
        this.serverControllers.get(id)?.abort();
        await this.connecting.get(id)?.catch(() => undefined);
        await this.clients.get(id)?.close();
        this.clients.delete(id);
        s.status = "Disconnected";
        if (method === "mcpServers.remove") {
          this.state.servers = this.state.servers.filter((v) => v.id !== id);
          delete this.vault.credentials[id];
        }
        await this.persist();
        await this.event(method);
        return { ok: true };
      }
      case "mcpServers.setToolPolicy": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
        if (!s.tools.some((t) => t.name === p.tool)) fail("Unknown discovered tool");
        s.policy[String(p.tool)] = p.allowed === true;
        await this.persist();
        await this.event(method);
        return { ok: true };
      }
      case "mcpServers.callTool": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server"),
          client = this.clients.get(id) ?? fail("Connect the server first");
        const t = s.tools.find((t) => t.name === p.tool) ?? fail("Unknown tool");
        if (!s.policy[t.name]) fail("Tool is not allowed");
        const validator = this.schemaValidator.getValidator(t.inputSchema);
        const valid = validator(p.arguments);
        if (!valid.valid) fail("Input does not match discovered tool schema");
        const result = await executeExternalMcp(
          this.host.core().guard,
          this.context(),
          [s.transport === "stdio" ? "shell.execute" : "network.access"],
          { server: id, tool: t.name },
          () =>
            client.callTool({ name: t.name, arguments: object(p.arguments) }, undefined, {
              timeout: 30000,
              signal: this.context().signal,
            }),
        );
        return { ok: true, result };
      }
      case "tasks.list":
        return {
          ok: true,
          tasks: this.state.tasks
            .filter((t) => (!p.project || t.project === p.project) && (!p.agent || t.agent === p.agent))
            .slice()
            .reverse(),
        };
      case "tasks.cancel": {
        const t = this.state.tasks.find((t) => t.id === id) ?? fail("Unknown task");
        await this.cancel(t);
        await this.persist();
        await this.event(method, t.project, t.agent);
        return { ok: true };
      }
      case "tasks.retry": {
        const t = this.state.tasks.find((t) => t.id === id) ?? fail("Unknown task");
        if (t.state === "Running") fail("Task is running");
        if (t.project !== this.state.active) fail("Select the task project before retrying");
        const replay = this.vault.replays[id] ?? fail("This task has no replay");
        const context =
          this.contexts.get(id) ??
          (replay.context
            ? {
                principal: replay.context.principal,
                ...(replay.context.scopeId ? { exposureScope: { id: replay.context.scopeId } } : {}),
              }
            : undefined);
        if (!context || context.principal.kind !== "local") fail("Retry requires a local agent context");
        if (replay.member === "$product") {
          void this.request(replay.method as ProductMethod, replay.input[0]).catch(() => undefined);
          return { ok: true };
        }
        const service = object(Reflect.get(this.host.core(), replay.member));
        const fn = service[replay.method];
        if (typeof fn !== "function") fail("Replay unavailable");
        void this.execute(replay.member, replay.method, [context, ...replay.input], (a) =>
          Reflect.apply(fn as (...args: unknown[]) => unknown, service, a),
        ).catch(() => undefined);
        return { ok: true };
      }
      case "monitoring.queryAudit":
        return { ok: true, events: await this.queryAudit(p) };
      case "monitoring.metrics":
        return {
          ok: true,
          workspace: this.activeProject.id,
          core: this.host.core().status(),
          tasks: {
            running: this.state.tasks.filter((t) => t.state === "Running").length,
            total: this.state.tasks.length,
          },
          connectedServers: this.clients.size,
        };
      case "monitoring.exportReport":
        return {
          ok: true,
          report: {
            generatedAt: now(),
            project: this.state.active,
            events: await this.queryAudit(p),
            tasks: this.state.tasks.map((t) => ({ ...t })),
            secrets: "redacted; request/response bodies omitted",
          },
        };
      default:
        return fail("Unknown product request");
    }
  }
  private async testConnector(id: string): Promise<Record<string, unknown>> {
    const c = this.state.connectors.find((c) => c.id === id) ?? fail("Configure the connector first");
    if (!c.enabled || !c.configured) fail("Connector is disconnected");
    if (this.activeProject.connectors.length && !this.activeProject.connectors.includes(id))
      fail("Connector is not enabled in project settings");
    if (c.projects.length && !c.projects.includes(this.state.active)) fail("Connector is not allowed for this project");
    const started = Date.now();
    const manifest = CONNECTOR_MANIFESTS.find((m) => m.id === id) ?? fail("Unknown connector");
    try {
      if (manifest.kind === "local") {
        if (id === "Remotion") {
          const file = await this.host.core().filesystem.readFile(this.context(), { path: "package.json" });
          if (file.truncated) fail("package.json exceeds inspection limit");
          const pkg = object(JSON.parse(file.content));
          if (
            !Object.hasOwn(object(pkg.dependencies), "remotion") &&
            !Object.hasOwn(object(pkg.devDependencies), "remotion")
          )
            fail("Active project does not declare remotion");
        }
        const result = await this.host.core().processes.exec(this.context(), {
          command: manifest.command!,
          args: manifest.args ?? [],
          cwd: this.activeProject.path,
        });
        c.status = result.exitCode === 0 ? "Connected" : "Failed";
      } else {
        const url = id === "Custom HTTP API" ? c.endpoint : manifest.probe;
        const auth = manifest.auth;
        if (!url) fail("Endpoint required");
        const credential = this.vault.credentials[id] ?? fail("Credential unavailable");
        const headers: Record<string, string> =
          auth === "xi-api-key"
            ? { "xi-api-key": credential }
            : auth === "anthropic"
              ? { "x-api-key": credential, "anthropic-version": "2023-06-01" }
              : { Authorization: `Bearer ${credential}` };
        const r = await this.host.core().network.request(this.context(), {
          url: url!,
          method: "GET",
          headers: {
            ...headers,
            ...(id === "Notion" ? { "Notion-Version": "2022-06-28" } : {}),
            ...(id === "Runway" ? { "X-Runway-Version": "2024-11-06" } : {}),
          },
          followRedirects: false,
          timeoutMs: 8000,
          maxResponseBytes: 65536,
        });
        c.httpStatus = r.status;
        let providerOk = true;
        if (r.truncated) fail("Provider probe response exceeded limit");
        if (id !== "Custom HTTP API" && r.status >= 200 && r.status < 300) {
          const body = JSON.parse(r.body);
          if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid provider response");
        }
        if (id === "Slack" || id === "TikTok") {
          const data = JSON.parse(r.body) as Record<string, unknown>;
          providerOk = id === "Slack" ? data.ok === true : object(data.error).code === "ok";
        }
        c.status =
          r.status === 401 || r.status === 403
            ? "Token rejected"
            : r.status >= 200 && r.status < 300 && providerOk
              ? "Connected"
              : "Failed";
      }
    } catch {
      c.status = "Failed — network/permission/provider unavailable";
    }
    c.checkedAt = now();
    c.latencyMs = Date.now() - started;
    await this.persist();
    await this.event("connectors.testConnection");
    return { ok: true, connector: c };
  }
  private async connectServer(id: string): Promise<Record<string, unknown>> {
    const pending = this.connecting.get(id);
    if (pending) return pending;
    const controller = new AbortController(),
      current = this.context();
    this.serverControllers.set(id, controller);
    const signal = current.signal ? AbortSignal.any([current.signal, controller.signal]) : controller.signal;
    const work = this.operationContext.run({ ...current, signal }, () => this.connectServerImpl(id));
    this.connecting.set(id, work);
    try {
      return await work;
    } finally {
      this.connecting.delete(id);
      this.serverControllers.delete(id);
    }
  }
  private async connectServerImpl(id: string): Promise<Record<string, unknown>> {
    const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
    if (this.clients.has(id)) return { ok: true, server: s };
    s.status = "Connecting";
    this.serverLog(s, "connecting");
    const client = new Client({ name: "crot-outbound", version: "0.1.0" });
    try {
      let transport: Transport;
      if (s.transport === "stdio") {
        const proc = await this.host
          .core()
          .processes.openTransport(this.context(), { command: s.command!, args: s.args, cwd: this.activeProject.path });
        transport = new PipeTransport(proc);
      } else {
        const token = this.vault.credentials[s.id];
        transport = new StreamableHTTPClientTransport(new URL(s.url!), {
          fetch: async (url, init) => {
            const target = new URL(String(url));
            if (target.origin !== new URL(s.url!).origin) throw new Error("Cross-origin MCP transport refused");
            const headers = Object.fromEntries(new Headers(init?.headers).entries());
            if (token) headers.authorization = `Bearer ${token}`;
            const context = this.context();
            const signals = [context.signal, init?.signal].filter((s): s is AbortSignal => !!s);
            const requestContext = signals.length ? { ...context, signal: AbortSignal.any(signals) } : context;
            const r = await this.host.core().network.request(requestContext, {
              url: target.href,
              method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
              headers,
              ...(typeof init?.body === "string" ? { body: init.body } : {}),
              followRedirects: false,
              maxResponseBytes: 1024 * 1024,
              timeoutMs: 10000,
            });
            return new Response(r.body || null, {
              status: r.status,
              headers: Object.fromEntries(
                Object.entries(r.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
              ),
            });
          },
        });
      }
      client.onclose = () => {
        this.clients.delete(id);
        s.status = "Disconnected";
        this.serverLog(s, "disconnected");
        void this.persist().catch(() => undefined);
      };
      await client.connect(transport, { timeout: 10000, signal: this.context().signal });
      const tools = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await executeExternalMcp(
          this.host.core().guard,
          this.context(),
          [],
          { server: id, discovery: "tools" },
          () => client.listTools(cursor ? { cursor } : undefined),
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (++pages > 100 || tools.length > 500) fail("Too many MCP tools");
      } while (cursor);
      s.tools = tools.map((t) => {
        this.schemaValidator.getValidator(t.inputSchema);
        return {
          name: t.name,
          inputSchema: t.inputSchema,
          ...(t.description ? { description: t.description.slice(0, 2000) } : {}),
        };
      });
      s.resources = [];
      if (client.getServerCapabilities()?.resources) {
        do {
          const page = await executeExternalMcp(
            this.host.core().guard,
            this.context(),
            [],
            { server: id, discovery: "resources" },
            () => client.listResources(cursor ? { cursor } : undefined),
          );
          s.resources.push(...page.resources);
          cursor = page.nextCursor;
          if (++pages > 100 || s.resources.length > 500) fail("Too many MCP resources");
        } while (cursor);
      }
      this.clients.set(id, client);
      s.status = "Connected";
      this.serverLog(s, "discovered");
    } catch (error) {
      await client.close().catch(() => undefined);
      s.status = "Failed";
      this.serverLog(s, error instanceof CrotError ? `connection_failed:${error.code}` : "connection_failed:protocol");
    }
    await this.persist();
    await this.event("mcpServers.connect");
    return { ok: true, server: s };
  }
  private serverLog(s: McpServer, event: string): void {
    s.logs = limited([...s.logs, { time: now(), event }], 100);
  }
  private agentId(context: AuthContext): string {
    const p = context.principal;
    return p.kind === "remote"
      ? `remote:${JSON.stringify([p.accountId, p.deviceId, p.clientId])}`
      : `local:${context.exposureScope?.id ?? context.session?.id ?? p.transport}`;
  }
  /** Narrowing authorization hook inside ExecutionGuard; never grants a Core capability. */
  authorize(context: AuthContext, operation: string): void {
    if (
      this.appliedTabPolicy &&
      operation.startsWith("browser.") &&
      !operation.startsWith("browser.policy.") &&
      !operation.startsWith("browser.link.") &&
      JSON.stringify(this.host.core().browser.getTabPolicy()) !== JSON.stringify(this.appliedTabPolicy)
    )
      this.host.core().browser.setTabPolicy(this.appliedTabPolicy);
    if (context.principal.transport === "owner-product") return;
    const id = this.agentId(context),
      a = this.state.agents.find((a) => a.id === id),
      project = this.activeProject;
    if (
      a &&
      (a.revoked ||
        (a.projects.length > 0 && !a.projects.includes(project.id)) ||
        (!a.browser && operation.startsWith("browser.")))
    )
      throw new CrotError("PERMISSION_DENIED", "Agent policy refuses this operation");
    if (project.agents.length && !project.agents.includes(id))
      throw new CrotError("PERMISSION_DENIED", "Agent is not allowed for the active project");
    if (project.tools.length && !project.tools.includes(operation))
      throw new CrotError("PERMISSION_DENIED", "Operation is not allowed for this project");
  }
  /** Called by CoreHolder for every adapter capability operation, using adapter-created identity only. */
  async execute(member: string, method: string, args: unknown[], run: (args: unknown[]) => unknown): Promise<unknown> {
    if (this.host.core().permissions.runtime.halted)
      throw new CrotError("PERMISSION_DENIED", "Emergency stop is active");
    const context = args[0] as AuthContext;
    if (!context?.principal || !this.state) return run(args);
    const id = this.agentId(context);
    let a = this.state.agents.find((a) => a.id === id);
    if (!a) {
      a = {
        id,
        name: context.principal.client?.name ?? context.principal.transport,
        kind: context.principal.kind,
        transport: context.principal.transport,
        connected: true,
        projects: [],
        browser: true,
        requestsPerMinute: 600,
        revoked: false,
        calls: 0,
        lastSeen: now(),
      };
      this.state.agents.push(a);
    }
    a.connected = true;
    a.calls++;
    a.lastSeen = now();
    const timestamps = (this.rate.get(id) ?? []).filter((t) => t > Date.now() - 60000);
    timestamps.push(Date.now());
    this.rate.set(id, timestamps);
    if (timestamps.length > a.requestsPerMinute) throw new CrotError("LIMIT_EXCEEDED", "Agent request limit exceeded");
    if (member === "processes" && ["list", "readOutput"].includes(method)) return run(args);
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const correlated = {
      ...context,
      signal: controller.signal,
      requestId: randomUUID(),
      productContext: { project: this.state.active, agent: id },
    };
    const task: Task = {
      id: correlated.requestId,
      operation: `${member}.${method}`,
      project: this.state.active,
      agent: id,
      state: "Running",
      progress: 0,
      startedAt: now(),
      artifacts: [],
      retryable:
        context.principal.kind === "local" &&
        context.principal.transport !== "owner-chat" &&
        member !== "$chat" &&
        member !== "$project",
    };
    this.state.tasks = limited([...this.state.tasks, task]);
    this.cancellations.set(task.id, controller);
    this.contexts.set(task.id, context);
    if (task.retryable)
      this.vault.replays[task.id] = {
        member,
        method,
        input: args.slice(1),
        context: { principal: context.principal, scopeId: context.exposureScope?.id ?? context.session?.id },
      };
    await this.persist();
    try {
      const result = await run([correlated, ...args.slice(1)]);
      const data = object(result);
      if (member === "processes" && method === "start" && typeof data.id === "string") {
        task.processId = data.id;
        // Cancellation may arrive before process.start returns its managed ID (including during audit).
        // Do not orphan a process whose task has already been marked Cancelled.
        if (controller.signal.aborted) {
          await this.stopTaskProcess(task);
          task.state = "Cancelled";
          task.endedAt = now();
          this.cancellations.delete(task.id);
        }
      } else {
        task.state = controller.signal.aborted ? "Cancelled" : "Completed";
        task.progress = 100;
        task.endedAt = now();
      }
      if (member === "filesystem" && ["writeFile", "createDirectory"].includes(method) && typeof data.path === "string")
        task.artifacts.push(data.path);
      return result;
    } catch (e) {
      task.state = controller.signal.aborted ? "Cancelled" : "Failed";
      task.endedAt = now();
      task.errorCode = e instanceof CrotError ? e.code : "OPERATION_FAILED";
      throw e;
    } finally {
      context.signal?.removeEventListener("abort", abort);
      if (!task.processId) this.cancellations.delete(task.id);
      await this.persist();
    }
  }
  /** Invalidate only work bound to this credential, not other agents with the same displayed name. */
  async invalidateToken(id: string, generation: string): Promise<void> {
    const tasks = this.state.tasks.filter((t) => {
      const binding = this.contexts.get(t.id)?.principal.tokenAccess;
      return t.state === "Running" && binding?.id === id && binding.generation === generation;
    });
    for (const task of tasks) this.cancellations.get(task.id)?.abort();
    await this.host.core().processes.cancelToken(id, generation);
    for (const t of tasks) {
      t.state = "Cancelled";
      t.endedAt = now();
      this.cancellations.delete(t.id);
    }
    await this.persist();
  }
  private async cancel(t: Task): Promise<void> {
    if (t.state !== "Running") fail("Task is not running");
    this.cancellations.get(t.id)?.abort();
    await this.stopTaskProcess(t);
    t.state = "Cancelled";
    t.endedAt = now();
    this.cancellations.delete(t.id);
  }
  private async stopTaskProcess(t: Task): Promise<void> {
    if (!t.processId) return;
    await this.host
      .core()
      .processes.stop(
        { principal: localPrincipal("owner-product"), productContext: { project: t.project, agent: t.agent } },
        { id: t.processId, force: true },
      );
  }
  private async pollProcesses(): Promise<void> {
    const pending = this.state.tasks.filter((t) => t.state === "Running" && t.processId);
    if (!pending.length) return;
    const processes = await this.host.core().processes.list(this.context());
    let changed = false;
    for (const t of pending) {
      const proc = processes.find((p) => p.id === t.processId);
      if (proc && proc.endedAt) {
        t.state = proc.exitCode === 0 ? "Completed" : "Failed";
        t.progress = 100;
        t.endedAt = now();
        changed = true;
        this.cancellations.delete(t.id);
      }
    }
    if (changed) await this.persist();
  }
  private async queryAudit(p: Record<string, unknown>): Promise<unknown[]> {
    const audit = this.host.core().status().audit;
    if (!audit.path) return [];
    const lines = createInterface({ input: createReadStream(audit.path, { encoding: "utf8" }), crlfDelay: Infinity });
    const tasks = new Map(this.state.tasks.map((t) => [t.id, t]));
    const result: unknown[] = [];
    for await (const line of lines) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const task = tasks.get(String(e.requestId));
      const details = object(e.details);
      let publication: import("zod").infer<typeof PublicationAuditSchema> | undefined;
      if (e.action === "publication" && typeof e.value === "string" && Buffer.byteLength(e.value) <= 8192) {
        try {
          const parsed = PublicationAuditSchema.safeParse(JSON.parse(e.value));
          if (parsed.success) publication = parsed.data;
        } catch {
          /* Invalid content never becomes display text. */
        }
      }
      const project = task?.project ?? publication?.project ?? details.project;
      const agent = task?.agent ?? details.agent;
      const type = e.operation ?? publication?.operation ?? e.action ?? e.event ?? e.kind;
      if (
        (p.from && String(e.timestamp) < String(p.from)) ||
        (p.to && String(e.timestamp) > String(p.to)) ||
        (p.project && project !== p.project) ||
        (p.agent && agent !== p.agent) ||
        (p.type && type !== p.type)
      )
        continue;
      // Allowlist, not blacklist: paths, command lines, headers, bodies, error messages and principal client metadata are omitted.
      if (result.length >= Number(p.limit ?? 200)) result.shift();
      result.push({
        id: e.id,
        timestamp: e.timestamp,
        type,
        outcome: e.outcome,
        durationMs: e.durationMs,
        project: project ?? null,
        agent: agent ?? null,
        errorCode: object(e.error).code ?? null,
        ...(publication
          ? { publicationId: publication.id, provider: publication.provider, publicationState: publication.state }
          : {}),
      });
    }
    return result.slice(-Number(p.limit ?? 200)).reverse();
  }
  /** Interrupt current work for an immutable Core replacement, without disabling future chat/polling. */
  async cancelWork(): Promise<void> {
    const stopped = this.chat.cancelAll();
    for (const controller of this.cancellations.values()) controller.abort();
    for (const controller of this.serverControllers.values()) controller.abort();
    await Promise.all([...this.connecting.values()].map((p) => p.catch(() => undefined)));
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    for (const server of this.state.servers) server.status = "Disconnected";
    for (const task of this.state.tasks)
      if (task.state === "Running") {
        task.state = "Cancelled";
        task.endedAt = now();
      }
    await stopped;
    await this.persist();
  }
  async abortAll(): Promise<void> {
    const chatStopped = this.chat.close();
    clearInterval(this.poller);
    for (const controller of this.cancellations.values()) controller.abort();
    for (const controller of this.serverControllers.values()) controller.abort();
    for (const task of this.state.tasks)
      if (task.state === "Running") {
        task.state = "Cancelled";
        task.endedAt = now();
      }
    for (const agent of this.state.agents) agent.connected = false;
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    await chatStopped;
    // Emergency stop: CROT's own OpenCode server (its agents) and a running installation stop too.
    this.runtime?.cancel();
    await this.openCode?.stop();
    await this.persist();
  }
  /** Last resort (CROT's emergency and 'exit' paths): CROT's OpenCode server and installation go at once. */
  terminateSync(): void {
    this.openCode?.terminateSync();
    this.runtime?.cancel();
  }
  /**
   * Local OpenCode for the owner UI: installed or not, where the Zen key comes from (never the key), and the
   * running server (url, managed, version; never its password).
   */
  private async openCodeStatus(): Promise<Record<string, unknown>> {
    const openCode = this.host.openCode;
    if (!this.openCode || !openCode) return { available: false, installCommand: OPENCODE_INSTALL_COMMAND };
    const [status, key, runtime] = await Promise.all([
      this.openCode.status(),
      findOpenCodeKey(openCode.local).catch(() => undefined),
      this.runtime?.status(),
    ]);
    return {
      available: true,
      installCommand: OPENCODE_INSTALL_COMMAND,
      installed: status.installed,
      // One-click install (straight from the npm registry: no Node.js or npm needed) and its state.
      ...(runtime ? { installable: true, runtime } : {}),
      ...(key ? { keySource: key.source } : {}),
      ...(status.server ? { server: status.server } : {}),
      // Why local OpenCode did not start last time: the UI offers CROT's verified OpenCode.
      ...(status.problem ? { problem: status.problem } : {}),
      // CROT's own copy serves: why the owner's own OpenCode is not used (not found, or why it did not start).
      ...(status.ownerProblem ? { ownerProblem: status.ownerProblem } : {}),
    };
  }
  /** Whether a configured provider uses CROT's own OpenCode server. */
  private openCodeInUse(): boolean {
    const providers = this.state.chatProviders ?? {};
    return !!providers.OpenCode?.managed || providers["OpenCode (Free & Zen)"]?.route === "local";
  }
  async close(): Promise<void> {
    this.avatars.close();
    await this.chat.close();
    await this.runtime?.close();
    await this.openCode?.close();
    clearInterval(this.poller);
    for (const controller of this.serverControllers.values()) controller.abort();
    await Promise.all([...this.connecting.values()].map((p) => p.catch(() => undefined)));
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    await this.persist();
    await this.writes;
  }
}
