/** Fixed platform upload protocols. No caller-selected URLs, headers, credentials or live filesystem paths. */
import { setTimeout as delay } from "node:timers/promises";
import { AccountAuthorizationError } from "../social/accounts.js";
import type { MediaSnapshot } from "../../core/publications/media.js";
import type { PublicationRecord } from "../../core/publications/service.js";
export interface PublicationPayload {
  record: Readonly<PublicationRecord>;
  media?: { snapshot: MediaSnapshot; data: Buffer };
  access: string;
  signal: AbortSignal;
}
export type PlatformPublisher = (
  payload: PublicationPayload,
) => Promise<{ state: "published" | "draft_uploaded"; id: string }>;
interface Endpoints {
  youtube: string;
  tiktok: string;
  x: string;
  fixture: boolean;
}
const production: Endpoints = {
  youtube: "https://www.googleapis.com",
  tiktok: "https://open.tiktokapis.com",
  x: "https://api.x.com",
  fixture: false,
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,256}$/.test(value))
    throw new Error("Provider returned an invalid publication identifier");
  return value;
};
async function json(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 65536) throw new Error("Provider response exceeded limit");
        chunks.push(next.value);
      }
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (response.status === 401) throw new AccountAuthorizationError("Provider requires reauthorization");
  const data: unknown = raw ? JSON.parse(raw) : {};
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Platform rejected publication");
  return object(data);
}
function publisher(endpoints: Endpoints): PlatformPublisher {
  return async ({ record, media, access, signal }) => {
    const fields = record.fields;
    if (!fields?.termsAccepted) throw new Error("Confirmed publication fields required");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
    const request = (url: string, init: RequestInit = {}, authenticated = true) =>
      fetch(url, {
        ...init,
        redirect: "error",
        signal: deadline,
        headers: { ...(authenticated ? { authorization: `Bearer ${access}` } : {}), ...init.headers },
      });
    const post = async (url: string, data: unknown) =>
      json(
        await request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
      );
    const uploadUrl = (value: string, provider: "youtube" | "tiktok") => {
      const u = new URL(value);
      if (
        u.username ||
        u.password ||
        u.hash ||
        (endpoints.fixture
          ? u.origin !== endpoints[provider]
          : u.protocol !== "https:" ||
            u.port !== "" ||
            !(provider === "youtube"
              ? u.hostname === "www.googleapis.com"
              : u.hostname === "open-upload.tiktokapis.com"))
      )
        throw new Error("Untrusted platform upload destination");
      return u.href;
    };
    const recipient = (provider: "youtube" | "tiktok" | "x", profileId: unknown) => {
      if (record.account.id !== provider + ":" + id(profileId))
        throw new AccountAuthorizationError("Publication recipient changed; reauthorization required");
    };
    if (record.request.provider === "youtube") {
      if (!media || media.snapshot.mime !== "video/mp4" || !["public", "private", "unlisted"].includes(fields.privacy))
        throw new Error("YouTube requires an MP4 snapshot and explicit video visibility");
      if (fields.comments || fields.duet || fields.stitch || fields.commercial)
        throw new Error("This YouTube adapter cannot apply the requested interaction/disclosure controls");
      const profile = await json(await request(endpoints.youtube + "/youtube/v3/channels?part=id&mine=true"));
      if (!Array.isArray(profile.items) || profile.items.length !== 1)
        throw new Error("YouTube recipient is ambiguous or unavailable");
      recipient("youtube", object(profile.items[0]).id);
      const start = await request(
        endpoints.youtube + "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-upload-content-type": media.snapshot.mime,
            "x-upload-content-length": String(media.data.length),
          },
          body: JSON.stringify({
            snippet: { title: fields.title, description: fields.description },
            status: { privacyStatus: fields.privacy },
          }),
        },
      );
      if (start.status === 401) throw new AccountAuthorizationError("Provider requires reauthorization");
      const location = start.headers.get("location");
      if (!start.ok || !location) throw new Error("YouTube upload session unavailable");
      await start.body?.cancel();
      const uploaded = await json(
        await request(uploadUrl(location, "youtube"), {
          method: "PUT",
          headers: { "content-type": media.snapshot.mime },
          body: new Uint8Array(media.data).buffer,
        }),
      );
      const video = id(uploaded.id);
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await json(
          await request(
            endpoints.youtube + "/youtube/v3/videos?part=status,processingDetails&id=" + encodeURIComponent(video),
          ),
        );
        const item = object(Array.isArray(result.items) ? result.items[0] : undefined),
          status = object(item.status),
          processing = object(item.processingDetails);
        if (
          ["failed", "rejected", "deleted"].includes(String(status.uploadStatus)) ||
          ["failed", "terminated"].includes(String(processing.processingStatus))
        )
          throw new Error("YouTube processing failed");
        if (status.uploadStatus === "processed" || processing.processingStatus === "succeeded") {
          if (status.privacyStatus !== fields.privacy) throw new Error("YouTube did not apply the confirmed privacy");
          return { state: "published", id: video };
        }
        await delay(1000, undefined, { signal: deadline });
      }
      throw new Error("YouTube processing remains unconfirmed; no automatic retry");
    }
    if (record.request.provider === "tiktok") {
      // Conservative unaudited-client contract: inbox draft only, never silently direct-post.
      if (!media || media.snapshot.mime !== "video/mp4" || fields.privacy !== "draft")
        throw new Error("TikTok is limited to explicit MP4 inbox drafts");
      if (fields.comments || fields.duet || fields.stitch)
        throw new Error("TikTok inbox API cannot apply direct-post interaction settings");
      const profile = await json(await request(endpoints.tiktok + "/v2/user/info/?fields=open_id"));
      if (object(profile.error).code !== "ok") throw new Error("TikTok recipient unavailable");
      recipient("tiktok", object(object(profile.data).user).open_id);
      const init = await post(endpoints.tiktok + "/v2/post/publish/inbox/video/init/", {
        source_info: {
          source: "FILE_UPLOAD",
          video_size: media.data.length,
          chunk_size: media.data.length,
          total_chunk_count: 1,
        },
      });
      if (object(init.error).code !== "ok") throw new Error("TikTok rejected upload initialization");
      const data = object(init.data),
        publication = id(data.publish_id);
      if (typeof data.upload_url !== "string") throw new Error("TikTok upload session unavailable");
      const uploaded = await request(
        uploadUrl(data.upload_url, "tiktok"),
        {
          method: "PUT",
          headers: {
            "content-type": "video/mp4",
            "content-range": `bytes 0-${media.data.length - 1}/${media.data.length}`,
          },
          body: new Uint8Array(media.data).buffer,
        },
        false,
      );
      if (!uploaded.ok) {
        await uploaded.body?.cancel();
        throw new Error("TikTok upload failed");
      }
      await uploaded.body?.cancel();
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await post(endpoints.tiktok + "/v2/post/publish/status/fetch/", { publish_id: publication });
        if (object(result.error).code !== "ok") throw new Error("TikTok status unavailable");
        const state = object(result.data).status;
        if (state === "SEND_TO_USER_INBOX" || state === "PUBLISH_COMPLETE")
          return { state: "draft_uploaded", id: publication };
        if (state === "FAILED") throw new Error("TikTok processing failed");
        await delay(1000, undefined, { signal: deadline });
      }
      throw new Error("TikTok processing remains unconfirmed; no automatic retry");
    }
    if (record.request.provider === "x") {
      if (fields.privacy !== "public" || fields.comments || fields.duet || fields.stitch || fields.commercial)
        throw new Error("X supports explicit public posts; unsupported controls cannot be silently ignored");
      const text = [fields.title, fields.description].filter(Boolean).join("\n\n");
      if (!text || [...text].length > 280) throw new Error("X post must contain 1–280 characters");
      // Visibility on X is determined by the account, not by the tweet request.
      // Recheck immediately before any upload; a stale OAuth profile is not a visibility guarantee.
      const profile = object((await json(await request(endpoints.x + "/2/users/me?user.fields=protected"))).data);
      recipient("x", profile.id);
      if (profile.protected !== false)
        throw new Error("X recipient changed or is protected; public publication refused");
      let mediaId: string | undefined;
      if (media) {
        if (!media.snapshot.mime.startsWith("image/") || media.data.length > 5 * 1024 * 1024)
          throw new Error("X adapter supports images up to 5 MiB");
        const form = new FormData();
        form.set("media", new Blob([new Uint8Array(media.data)], { type: media.snapshot.mime }), media.snapshot.name);
        form.set("media_category", "tweet_image");
        const uploaded = await json(await request(endpoints.x + "/2/media/upload", { method: "POST", body: form }));
        const data = object(uploaded.data);
        if (object(data.processing_info).state && object(data.processing_info).state !== "succeeded")
          throw new Error("X media processing unconfirmed");
        mediaId = id(data.id);
      }
      const result = await post(endpoints.x + "/2/tweets", {
        text,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      });
      return { state: "published", id: id(object(result.data).id) };
    }
    throw new Error("Provider publication adapter is unavailable");
  };
}
export const productionPublisher = (): PlatformPublisher => publisher(production);
/** Actual local HTTP contract fixture only; never deployment, renderer or agent configuration. */
export function fixturePublisher(origin: string): PlatformPublisher {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== origin)
    throw new Error("Invalid fixture publisher origin");
  return publisher({ youtube: origin, tiktok: origin, x: origin, fixture: true });
}
