import { z } from "zod";
export const ChatBaseProviderSchema = z.enum([
  "OpenAI",
  "Anthropic",
  "Google Gemini",
  "OpenRouter",
  "OpenCode (Free & Zen)",
  "Custom API",
  "OpenAI-compatible",
  "Local HTTP",
  "OpenCode",
  "Notion Agents",
]);
/** A built-in provider kind (the vendor presets plus the two custom families). */
export type ChatBaseProvider = z.infer<typeof ChatBaseProviderSchema>;
/** Custom provider families: each saved server is its own profile ("Custom API:river"). */
export const CUSTOM_PROVIDER_FAMILIES = ["Custom API", "OpenAI-compatible"] as const;
export type CustomProviderFamily = (typeof CUSTOM_PROVIDER_FAMILIES)[number];
/** A saved custom profile key: family, a colon and a host-derived slug. */
export type ChatProfileKey = `${CustomProviderFamily}:${string}`;
export const CHAT_PROFILE_KEY = /^(?:Custom API|OpenAI-compatible):[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const ChatProviderSchema = z.union([
  ChatBaseProviderSchema,
  z
    .string()
    .regex(CHAT_PROFILE_KEY)
    .transform((v) => v as ChatProfileKey),
]);
export type ChatProvider = ChatBaseProvider | ChatProfileKey;
/** The provider kind of a key: "Custom API:river" → "Custom API". */
export function baseProvider(provider: ChatProvider): ChatBaseProvider {
  const colon = provider.indexOf(":");
  return (colon < 0 ? provider : provider.slice(0, colon)) as ChatBaseProvider;
}
export const isCustomFamily = (provider: ChatProvider): boolean =>
  (CUSTOM_PROVIDER_FAMILIES as readonly string[]).includes(baseProvider(provider));
export const isProfileKey = (provider: ChatProvider): provider is ChatProfileKey => provider.includes(":");
export const ChatConfigureSchema = z
  .object({
    provider: ChatProviderSchema,
    endpoint: z.string().url().max(2048).optional(),
    defaultModel: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\0]*$/)
      .optional(),
    username: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^:\r\n\0]*$/)
      .optional(),
    credential: z
      .string()
      .max(8192)
      .regex(/^[^\r\n\0]*$/)
      .optional(),
    /** Protocol format for Custom API: "openai" (default) or "anthropic" */
    protocol: z.enum(["openai", "anthropic"]).optional(),
    /** OpenCode workspace agent (earlier connections): CROT starts and stops its own `opencode serve` instead of using `endpoint`. */
    managed: z.boolean().optional(),
    /** Display name of a custom profile ("River"); derived from the endpoint host when omitted. */
    label: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .optional(),
  })
  .strict();
export const ChatStartSchema = z
  .object({
    provider: ChatProviderSchema,
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\0]*$/),
    message: z.string().min(1).max(32000),
    /** Continue this conversation thread: earlier turns are sent to the provider as history. */
    thread: z.string().uuid().optional(),
    /** Read-only tools for the open project (list, read, stat, search); on by default. */
    projectTools: z.boolean().default(true),
    tools: z.array(z.string().min(1).max(128)).max(16).default([]),
    attachments: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[^\r\n\0]*$/),
            mime: z.enum(["text/plain", "image/png", "image/jpeg", "image/webp"]),
            data: z
              .string()
              .max(128000)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict(),
      )
      .max(4)
      .default([]),
  })
  .strict()
  .refine(
    (p) => p.attachments.reduce((n, a) => n + a.data.length, 0) <= 128000,
    "Attachments exceed 96 KB decoded in total",
  );
export type ChatStart = z.infer<typeof ChatStartSchema>;

/** One turn of a conversation thread, as sent to the provider. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
