import { ProjectSecretAccessSchema } from "../permissions/project-secrets.js";
import { z } from "zod";
import {
  DEFAULT_APPROVAL_MAX_PENDING,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
} from "../approvals/rules.js";
import { UNTRUSTED_CONTENT_SETTINGS } from "../approvals/exposure.js";
import { CapabilitySchema } from "../permissions/capabilities.js";
import { NetworkPolicyConfigSchema } from "../permissions/network/policy.js";
import { PERMISSION_MODES } from "../permissions/policy.js";
import { CONFINEMENT_NETWORK_MODES, STARTUP_PATH_MODES } from "../platform/types.js";

/**
 * CROT configuration (version 1).
 *
 * No paths are built in: the workspace root is always supplied by the user,
 * either in a config file or on the command line.
 */
export const LimitsSchema = z
  .object({
    /** Maximum bytes returned by a single file read. */
    maxReadBytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    /** Default timeout for foreground commands. */
    defaultCommandTimeoutMs: z.number().int().positive().default(120_000),
    /** Upper bound a caller may request for a foreground command timeout. */
    maxCommandTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60 * 60 * 1000),
    /** Maximum captured bytes per output stream (stdout / stderr) of a command. */
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** Maximum number of concurrently running background processes. */
    maxBackgroundProcesses: z.number().int().positive().default(16),
    /** Default timeout of a network request (DNS, connect, every redirect hop and the response body). */
    defaultNetworkTimeoutMs: z.number().int().positive().default(30_000),
    /** Upper bound a caller may request for a network request timeout. */
    maxNetworkTimeoutMs: z.number().int().positive().default(120_000),
    /** Maximum response body bytes returned by a network request (the rest is reported as truncated). */
    maxNetworkResponseBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** Maximum redirects a network request follows. */
    maxNetworkRedirects: z.number().int().min(0).max(20).default(5),
  })
  .strict();

export const AuditConfigSchema = z
  .object({
    /**
     * file: append JSON lines to `path`; stderr: write JSON lines to standard error;
     * none: disable auditing. Audit data never leaves the machine.
     */
    sink: z.enum(["file", "stderr", "none"]).default("stderr"),
    /** Audit file for the file sink; defaults to audit.jsonl in the platform logs directory. */
    path: z.string().min(1).optional(),
  })
  .strict();

/** environment.allow entries: a variable name, or a prefix of at least two characters followed by "*". */
const ENV_ALLOW_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_().]{0,127}|[A-Za-z_][A-Za-z0-9_().]{1,126}\*)$/;
const ENV_ALLOW_MESSAGE = 'expected a variable name or a prefix ending in "*" (at least two characters before it)';

export const EnvironmentConfigSchema = z
  .object({
    /**
     * PATH for commands. auto: on macOS/Linux, read the login shell's PATH when
     * CROT was not started from a shell (desktop-launched MCP clients);
     * login-shell: always; inherited: use the PATH CROT was started with.
     */
    path: z.enum(STARTUP_PATH_MODES).default("auto"),
    /**
     * Extra variables passed from the CROT environment to the children of
     * process tools (shell.execute, process.manage), on top of the built-in
     * allowlist (WP-21, docs/SECURITY.md). Exact names, or a prefix ending in
     * "*" (e.g. "MYAPP_*"). Everything else is withheld.
     */
    allow: z.array(z.string().regex(ENV_ALLOW_PATTERN, ENV_ALLOW_MESSAGE)).max(256).default([]),
  })
  .strict();

export const HTTP_AUTH_MODES = ["local-token"] as const;
export const HTTP_TOKEN_STORAGES = ["secret-store", "token-file"] as const;
export type HttpAuthMode = (typeof HTTP_AUTH_MODES)[number];

export const HttpAuthConfigSchema = z
  .object({
    mode: z.enum(HTTP_AUTH_MODES).default("local-token"),
    storage: z.enum(HTTP_TOKEN_STORAGES).default("secret-store"),
    tokenFile: z.string().min(1).optional(),
  })
  .strict();

export const HttpConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(7337),
    auth: HttpAuthConfigSchema.default({ mode: "local-token", storage: "secret-store" }),
    allowedOrigins: z.array(z.string().min(1)).default([]),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .default(4 * 1024 * 1024),
    maxSessions: z.number().int().positive().default(16),
    maxConcurrentRequests: z.number().int().positive().max(1024).default(32),
    sessionIdleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
  })
  .strict();

export const BrowserConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    downloadsDirectory: z
      .string()
      .min(1)
      .optional()
      .describe("Owner-configured absolute browser download directory; defaults to ~/Downloads."),
  })
  .strict();

export const SecretsConfigSchema = z
  .object({
    store: z.enum(["auto", "os", "file"]).default("auto"),
  })
  .strict();

export const ConfinementConfigSchema = z
  .object({
    network: z.enum(CONFINEMENT_NETWORK_MODES).default("on"),
  })
  .strict();

export const ApprovalRuleConfigSchema = z
  .object({
    id: z.string().min(1).max(100),
    match: z
      .object({
        operations: z.array(z.string().min(1)).min(1).optional(),
        capabilities: z.array(CapabilitySchema).min(1).optional(),
        principalKinds: z
          .array(z.enum(["local", "remote"]))
          .min(1)
          .optional(),
        modes: z.array(z.enum(PERMISSION_MODES)).min(1).optional(),
        outsideWorkspace: z.boolean().optional(),
        exposed: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const ApprovalsConfigSchema = z
  .object({
    rules: z.array(ApprovalRuleConfigSchema).default([]),
    timeoutMs: z.number().int().positive().max(MAX_APPROVAL_TIMEOUT_MS).default(DEFAULT_APPROVAL_TIMEOUT_MS),
    maxPending: z.number().int().positive().default(DEFAULT_APPROVAL_MAX_PENDING),
    untrustedContent: z.enum(UNTRUSTED_CONTENT_SETTINGS).default("require-approval"),
  })
  .strict();

/**
 * Default network allow-list for built-in AI chat providers and local model servers.
 * These hosts are whitelisted by default so that owners can use Cloud LLM, Local Models
 * and Workspaces sections without editing permissions.network.allow manually.
 * All loopback entries require explicit IP rules because name rules never allow
 * non-public addresses (NetworkPolicy contract).
 */
export const DEFAULT_AI_NETWORK_ALLOW: readonly string[] = [
  // Cloud AI providers (HTTPS port 443 only)
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.river.ai",
  "api.notion.com",
  // Local model servers — loopback must be IP/CIDR rules
  "127.0.0.1:11434",  // Ollama default
  "127.0.0.1:1234",   // LM Studio default
  "127.0.0.1:4096",   // OpenCode default
  "127.0.0.1:8080",   // common local model port
];

export const CrotConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    workspace: z
      .object({
        root: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict(),
    permissions: z
      .object({
        mode: z.enum(PERMISSION_MODES).default("sandbox"),
        capabilities: z.array(CapabilitySchema).optional(),
        network: NetworkPolicyConfigSchema.default({ allow: [...DEFAULT_AI_NETWORK_ALLOW], deny: [] }),
        projectSecrets: ProjectSecretAccessSchema.default({ allow: [] }),
        approvals: ApprovalsConfigSchema.default(ApprovalsConfigSchema.parse({})),
      })
      .strict()
      .default({
        mode: "sandbox",
        network: { allow: [...DEFAULT_AI_NETWORK_ALLOW], deny: [] },
        approvals: ApprovalsConfigSchema.parse({}),
        projectSecrets: { allow: [] },
      }),
    limits: LimitsSchema.default(LimitsSchema.parse({})),
    audit: AuditConfigSchema.default({ sink: "stderr" }),
    environment: EnvironmentConfigSchema.default({ path: "auto", allow: [] }),
    http: HttpConfigSchema.default(HttpConfigSchema.parse({})),
    browser: BrowserConfigSchema.default({ enabled: false }),
    secrets: SecretsConfigSchema.default({ store: "auto" }),
    confinement: ConfinementConfigSchema.default({ network: "on" }),
  })
  .strict();

export type CrotConfig = z.output<typeof CrotConfigSchema>;
export type CrotConfigInput = z.input<typeof CrotConfigSchema>;
export type Limits = z.output<typeof LimitsSchema>;
export type AuditConfig = z.output<typeof AuditConfigSchema>;
export type HttpConfig = z.output<typeof HttpConfigSchema>;
export type HttpConfigInput = z.input<typeof HttpConfigSchema>;
export type ApprovalsConfig = z.output<typeof ApprovalsConfigSchema>;
export type BrowserConfig = z.output<typeof BrowserConfigSchema>;
export type ConfinementConfig = z.output<typeof ConfinementConfigSchema>;
export type BrowserConfigInput = z.input<typeof BrowserConfigSchema>;
