import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { waitFor } from "../../helpers.js";
import {
  PublicationService,
  type PublicationRecord,
  type PublicationAccount,
} from "../../../src/core/publications/service.js";
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});
it("actual HTTP send is impossible without session-bound, explicit-privacy, one-shot confirmation; audit records every transition", async () => {
  let sends = 0,
    generation = "grant-1",
    now = 1900000000000;
  server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    expect(body.fields.privacy).toBe("private");
    expect(body.fields.termsAccepted).toBe(true);
    sends++;
    res.setHeader("content-type", "application/json");
    res.end('{"id":"fixture-post-1"}');
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const audit: string[] = [],
    saved: PublicationRecord[][] = [];
  const account = (): PublicationAccount => ({
    id: "account-1",
    provider: "youtube",
    generation,
    handle: "@fixture",
    privacy: ["private"],
    destinationLabel: "@fixture",
  });
  const service = new PublicationService({
    now: () => now,
    authorizePrepare: async () => account(),
    persist: async (records) => {
      saved.push(structuredClone([...records]));
    },
    audit: async (e) => {
      audit.push(e.state);
    },
    send: async (record, signal) => {
      const res = await fetch(origin + "/publish", {
        method: "POST",
        redirect: "error",
        signal,
        body: JSON.stringify(record),
      });
      return { state: "published", id: ((await res.json()) as { id: string }).id };
    },
  });
  const request = { provider: "youtube", accountId: "account-1", title: "Title", description: "Post" };
  const prepared = await service.preparePublication("project-1", request);
  expect(prepared.state).toBe("pending_publication");
  expect(sends).toBe(0);
  const owner = {},
    agent = {};
  const opened = service.openForOwner(prepared.id, owner);
  const confirm = {
    id: prepared.id,
    confirmation: opened.confirmation,
    title: "Edited",
    description: "Post",
    privacy: "private",
    termsAccepted: true,
  };
  await expect(service.confirmPublication(agent, confirm)).rejects.toThrow("confirmation");
  const { privacy: _, ...noPrivacy } = confirm;
  void _;
  await expect(service.confirmPublication(owner, noPrivacy)).rejects.toThrow();
  await expect(service.confirmPublication(owner, { ...confirm, termsAccepted: false })).rejects.toThrow();
  await expect(service.confirmPublication(owner, { ...confirm, commercial: true })).rejects.toThrow("brand category");
  await expect(service.confirmPublication(owner, { ...confirm, privacy: "public" })).rejects.toThrow("Privacy");
  await expect(service.confirmPublication(owner, { ...confirm, accountId: "attacker" })).rejects.toThrow();
  expect(sends).toBe(0);
  const result = await service.confirmPublication(owner, confirm);
  expect(result.state).toBe("published");
  expect(sends).toBe(1);
  expect(audit).toEqual(["pending_publication", "queued", "processing", "published"]);
  expect(saved.at(-1)?.[0]?.resultId).toBe("fixture-post-1");
  await expect(service.confirmPublication(owner, confirm)).rejects.toThrow("confirmation");
  expect(sends).toBe(1);
  const another = await service.preparePublication("project-1", request),
    next = service.openForOwner(another.id, owner);
  generation = "revoked-grant";
  expect(
    (await service.confirmPublication(owner, { ...confirm, id: another.id, confirmation: next.confirmation })).state,
  ).toBe("failed");
  expect(sends).toBe(1);
  const expired = await service.preparePublication("project-1", request),
    last = service.openForOwner(expired.id, owner);
  now += 180001;
  await expect(
    service.confirmPublication(owner, { ...confirm, id: expired.id, confirmation: last.confirmation }),
  ).rejects.toThrow("expired");
});
it("a closed owner session cannot confirm and uncertain delivery is never retried automatically", async () => {
  const audit: string[] = [];
  let sendCount = 0;
  const account: PublicationAccount = {
    id: "a",
    provider: "tiktok",
    generation: "g",
    handle: "@test",
    privacy: ["draft", "self_only"],
    restricted: true,
    destinationLabel: "@test",
  };
  const host = {
    authorizePrepare: async () => account,
    persist: async () => {},
    audit: async (e: { state: string }) => {
      audit.push(e.state);
    },
    send: async () => {
      sendCount++;
      throw new Error("socket lost after send");
    },
  };
  const service = new PublicationService(host),
    owner = {};
  const draft = await service.preparePublication("p", {
    provider: "tiktok",
    accountId: "a",
    title: "",
    description: "",
  });
  const opened = service.openForOwner(draft.id, owner);
  const input = {
    id: draft.id,
    confirmation: opened.confirmation,
    title: "",
    description: "",
    privacy: "draft",
    termsAccepted: true,
  };
  service.endOwnerSession(owner);
  await expect(service.confirmPublication(owner, input)).rejects.toThrow("confirmation");
  const fresh = service.openForOwner(draft.id, owner);
  expect(await service.confirmPublication(owner, { ...input, confirmation: fresh.confirmation })).toMatchObject({
    state: "failed",
    error: "delivery_unknown",
  });
  await expect(service.confirmPublication(owner, { ...input, confirmation: fresh.confirmation })).rejects.toThrow();
  expect(sendCount).toBe(1);
  expect(audit.at(-1)).toBe("failed");
  const recovered = new PublicationService(host);
  await recovered.restore(service.list().map((r) => ({ ...r, state: "processing" })));
  expect(recovered.list()[0]).toMatchObject({ state: "failed", error: "delivery_unknown" });
  expect(sendCount).toBe(1);
});
it("does not expose a terminal delivery status or result ID until durable audit has completed", async () => {
  let release!: () => void,
    auditEntered = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const service = new PublicationService({
    authorizePrepare: async () => ({
      id: "a",
      provider: "x",
      generation: "g",
      handle: "@fixture",
      privacy: ["public"],
      destinationLabel: "@fixture",
    }),
    persist: async () => {},
    send: async () => ({ state: "published", id: "remote-id" }),
    audit: async (event) => {
      if (event.state === "published") {
        auditEntered = true;
        await barrier;
      }
      events.push(event.state);
    },
  });
  const owner = {},
    draft = await service.preparePublication("p", {
      provider: "x",
      accountId: "a",
      title: "Title",
      description: "Post",
    });
  const permit = service.openForOwner(draft.id, owner);
  const completion = service.confirmPublication(owner, {
    id: draft.id,
    confirmation: permit.confirmation,
    title: "Title",
    description: "Post",
    privacy: "public",
    termsAccepted: true,
  });
  try {
    await waitFor(() => auditEntered);
    expect(service.list("p")[0]).toMatchObject({ id: draft.id, state: "processing" });
    expect(service.list("p")[0]?.resultId).toBeUndefined();
    expect(events).toEqual(["pending_publication", "queued", "processing"]);
  } finally {
    release();
  }
  expect((await completion).state).toBe("published");
  expect(service.list("p")[0]).toMatchObject({ state: "published", resultId: "remote-id" });
  expect(events).toEqual(["pending_publication", "queued", "processing", "published"]);
});
