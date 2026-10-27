/** Shared agent preparation / owner preview shapes; neither grants confirmation authority. */
import { z } from "zod";
import { ArtifactPathSchema } from "../platform/workspace-artifacts.js";
import { PreparePublicationSchema } from "./service.js";
export const PublicationRequestSchema = PreparePublicationSchema.omit({ mediaId: true, destination: true })
  .extend({
    provider: z.enum(["youtube", "tiktok", "x"]),
    mediaPath: ArtifactPathSchema.optional(),
  })
  .strict()
  // The authenticated control transport has a 64-KiB frame cap. Bound escaped UTF-8, not JS characters.
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 24_000,
    "Publication metadata exceeds owner frame budget",
  );
export const PublicationPreviewSchema = z
  .object({ id: z.string().uuid(), offset: z.number().int().min(0), length: z.number().int().min(1).max(24_576) })
  .strict();
