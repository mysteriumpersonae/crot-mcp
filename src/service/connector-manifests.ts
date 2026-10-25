/** Stage B built-ins: data only, never arbitrary imported executable plugins. */
import { ScratchDirectorySchema } from "../core/platform/scratch-directory.js";
import { z } from "zod";
export const ConnectorManifestSchema = z
  .object({
    id: z.string().min(1).max(128),
    category: z.string(),
    kind: z.enum(["local", "web"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    probe: z.string().url().optional(),
    auth: z.enum(["bearer", "xi-api-key", "anthropic"]).optional(),
  })
  .strict();
const entries = [
  { id: "GitHub", category: "Development", probe: "https://api.github.com/user" },
  { id: "GitLab", category: "Development", probe: "https://gitlab.com/api/v4/user" },
  { id: "ElevenLabs", category: "AI & Media", probe: "https://api.elevenlabs.io/v1/user", auth: "xi-api-key" },
  { id: "Runway", category: "AI & Media", probe: "https://api.dev.runwayml.com/v1/organization" },
  { id: "OpenAI", category: "AI & Media", probe: "https://api.openai.com/v1/models" },
  { id: "Anthropic", category: "AI & Media", probe: "https://api.anthropic.com/v1/models", auth: "anthropic" },
  {
    id: "YouTube",
    category: "Video & Social",
    probe: "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
  },
  { id: "TikTok", category: "Video & Social", probe: "https://open.tiktokapis.com/v2/user/info/?fields=open_id" },
  { id: "Notion", category: "Productivity", probe: "https://api.notion.com/v1/users/me" },
  { id: "Google Drive", category: "Productivity", probe: "https://www.googleapis.com/drive/v3/about?fields=user" },
  { id: "Slack", category: "Productivity", probe: "https://slack.com/api/auth.test" },
  { id: "Custom HTTP API", category: "Other" },
  { id: "FFmpeg Media Pipeline", category: "AI & Media", command: "ffmpeg", args: ["-version"] },
  {
    id: "Python",
    category: "Development",
    command: process.platform === "win32" ? "python" : "python3",
    args: ["--version"],
  },
  { id: "Node.js", category: "Development", command: "node", args: ["--version"] },
  { id: "Remotion", category: "AI & Media", command: "node", args: ["--version"] },
] as const;
export const CONNECTOR_MANIFESTS = Object.freeze(
  entries.map((e) =>
    Object.freeze(
      ConnectorManifestSchema.parse({
        ...e,
        kind: "command" in e ? "local" : "web",
        ...(!("command" in e) ? { auth: "auth" in e ? e.auth : "bearer" } : {}),
      }),
    ),
  ),
);
export const SkillSchema = z
  .object({
    id: z.string().regex(/^custom-[a-z0-9-]{1,64}$/),
    name: z.string().min(1).max(128),
    command: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\r\n\0]+$/),
    args: z.array(z.string().max(4096)).max(128).default([]),
    workingDirectory: ScratchDirectorySchema,
  })
  .strict();
export type CustomSkill = z.infer<typeof SkillSchema>;
