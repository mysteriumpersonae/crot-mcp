import { rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownerRequest, publicationFixture, fixtureImage } from "./fixture.js";
import type { PublicationRecord } from "../../../src/core/publications/service.js";
import { DeviceIdentity } from "../../../src/service/identity.js";
import { CrotCore } from "../../../src/core/crot-core.js";
import type { ConfinementStatus } from "../../../src/core/platform/types.js";
import { waitFor } from "../../helpers.js";
import { connectChannel, MAX_SERVER_FRAME_BYTES } from "../../../src/service/channel.js";
import { secretCredentialStore, serviceEndpoint } from "../../../src/service/endpoints.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
type Rows = { publications: Array<{ id: string; state: string; error?: string }> };
const fields = (id: string, confirmation: string) => ({
  id,
  confirmation,
  title: "Reviewed",
  description: "Human approved",
  privacy: "public",
  termsAccepted: true,
});
it(
  "real MCP draft -> actual owner-RPC snapshot review -> one-shot HTTP send -> durable audit, with cross-owner/replay/substitution refusal",
  { timeout: 30_000 },
  async () => {
    const f = await publicationFixture();
    cleanup.push(f.close);
    const draft = await f.prepare(),
      other = await f.newOwner();
    expect(f.writes()).toBe(0);
    const tools = await f.agent.listTools();
    expect(tools.tools.some((tool) => tool.name === "publication_prepare")).toBe(true);
    expect(tools.tools.some((tool) => /publication.*confirm|credential|access_token/.test(tool.name))).toBe(false);
    const opened = await ownerRequest<{ publication: PublicationRecord; confirmation: string }>(
      f.owner,
      "publications.open",
      { id: draft.id },
    );
    expect(opened.publication.account.handle).toBe("@fixture");
    await rename(path.join(f.dirs.workspace, "image.png"), path.join(f.dirs.workspace, ".env.future"));
    await writeFile(path.join(f.dirs.workspace, "image.png"), "replaced by agent");
    const preview = await ownerRequest<{ data: string; sha256: string }>(f.owner, "publications.preview", {
      id: draft.id,
      offset: 0,
      length: 24576,
    });
    expect(Buffer.from(preview.data, "base64")).toEqual(fixtureImage);
    expect(preview.sha256).toBe(draft.account.media!.sha256);
    const confirm = fields(draft.id, opened.confirmation);
    await expect(other.request("publications.confirm", confirm)).rejects.toThrow("confirmation");
    await expect(
      (await f.newOwner()).request("publications.confirm", { ...confirm, accountId: "other" }),
    ).rejects.toThrow();
    const { privacy: _, ...noPrivacy } = confirm;
    void _;
    await expect((await f.newOwner()).request("publications.confirm", noPrivacy)).rejects.toThrow();
    await expect(f.owner.request("publications.confirm", { ...confirm, commercial: true })).rejects.toThrow(
      "brand category",
    );
    expect(f.writes()).toBe(0);
    expect(await f.owner.request("publications.confirm", confirm)).toMatchObject({ ok: true, state: "queued" });
    await expect(f.owner.request("publications.confirm", confirm)).rejects.toThrow("confirmation");
    await waitFor(async () =>
      (await ownerRequest<Rows>(f.owner, "publications.list")).publications.some(
        (row) => row.id === draft.id && row.state === "published",
      ),
    );
    expect(f.writes()).toBe(1);
    expect(f.uploads[0]!.includes(fixtureImage)).toBe(true);
    const audit = await f.audit();
    for (const state of ["pending_publication", "queued", "processing", "published"])
      expect(audit).toContain("publication." + state);
    expect(audit).not.toMatch(/fixture-access|fixture-refresh|fixture-code|Human approved/);
    for (const name of ["publications.json", "product-state.json", "social-accounts.json"])
      expect(await readFile(path.join(f.stateDir, name), "utf8")).not.toMatch(/fixture-access|fixture-refresh/);
  },
);
it(
  "owner cancellation persists without sending and disconnect invalidates a permit even without an approval subscription",
  { timeout: 30_000 },
  async () => {
    const f = await publicationFixture();
    cleanup.push(f.close);
    const draft = await f.prepare(undefined),
      other = await f.newOwner();
    const opened = await ownerRequest<{ confirmation: string }>(other, "publications.open", { id: draft.id });
    other.close();
    await expect(f.owner.request("publications.confirm", fields(draft.id, opened.confirmation))).rejects.toThrow(
      "confirmation",
    );
    expect(await f.owner.request("publications.cancel", { id: draft.id })).toMatchObject({
      ok: true,
      state: "cancelled",
      cancellationRequested: false,
    });
    await expect(f.owner.request("publications.open", { id: draft.id })).rejects.toThrow("pending");
    expect(f.writes()).toBe(0);
    expect(await f.audit()).toContain("publication.cancelled");
  },
);
it(
  "fresh host authorization is rechecked after human confirmation and production does not inherit the trusted fixture grant",
  { timeout: 30_000 },
  async () => {
    const f = await publicationFixture();
    cleanup.push(f.close);
    const draft = await f.prepare(undefined),
      opened = await ownerRequest<{ confirmation: string }>(f.owner, "publications.open", { id: draft.id });
    f.allow(false);
    await f.owner.request("publications.confirm", fields(draft.id, opened.confirmation));
    await waitFor(
      async () => (await ownerRequest<Rows>(f.owner, "publications.list")).publications[0]?.state === "failed",
    );
    expect(f.writes()).toBe(0);
    const production = await publicationFixture({ productionGate: true });
    cleanup.push(production.close);
    await expect(production.prepare(undefined)).rejects.toThrow(/Pro entitlement/);
    expect(production.writes()).toBe(0);
  },
);
it(
  "global emergency stop aborts a real in-flight publication and leaves no successful-delivery claim",
  { timeout: 30_000 },
  async () => {
    const f = await publicationFixture();
    cleanup.push(f.close);
    f.hold(true);
    const draft = await f.prepare(undefined),
      opened = await ownerRequest<{ confirmation: string }>(f.owner, "publications.open", { id: draft.id });
    await f.owner.request("publications.confirm", fields(draft.id, opened.confirmation));
    await waitFor(() => f.writes() === 1);
    expect(await f.owner.request("security.kill", {})).toMatchObject({ halted: true });
    expect(await readFile(path.join(f.stateDir, "publications.json"), "utf8")).toContain("delivery_unknown");
    expect(await f.audit()).toContain("publication.failed");
    expect((await ownerRequest<Rows>(f.owner, "publications.list")).publications[0]).toMatchObject({
      state: "failed",
      error: "delivery_unknown",
    });
  },
);

it(
  "service/MCP credentials cannot authenticate owner-RPC or confirm a pending publication",
  { timeout: 30000 },
  async () => {
    const f = await publicationFixture();
    cleanup.push(f.close);
    const draft = await f.prepare(undefined);
    const opened = await ownerRequest<{ confirmation: string }>(f.owner, "publications.open", { id: draft.id });
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const credentials = secretCredentialStore(f.stateDir, privateFiles);
    const ownerToken = await credentials.read("control"),
      serviceToken = await credentials.read("service");
    if (!ownerToken || !serviceToken) throw Error("missing positive-control credentials");
    await expect(
      connectChannel(serviceEndpoint(f.stateDir, "control", ownerToken).path, {
        channel: "control",
        credential: serviceToken,
        maxFrameBytes: MAX_SERVER_FRAME_BYTES,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();
    // Even knowing a real dialog permit does not turn an MCP tool call into owner authority.
    const result = await f.agent.callTool({
      name: "publications.confirm",
      arguments: fields(draft.id, opened.confirmation),
    });
    expect(result.isError).toBe(true);
    expect(f.writes()).toBe(0);
    expect(await f.owner.request("ping")).toMatchObject({ state: "running" });
  },
);

// Host status seams prove production wiring, NOT OS or commercial qualification.
// Only preparation is admitted. Readiness is revoked before confirm; no live send is authorized.
it(
  "production admits a qualified Pro draft but rechecks native isolation before delivery",
  { timeout: 30000 },
  async () => {
    vi.spyOn(DeviceIdentity.prototype, "refreshCommercialIfNeeded").mockResolvedValue();
    vi.spyOn(DeviceIdentity.prototype, "commercialStatus").mockReturnValue({
      state: "current",
      plan: "pro",
      status: "active",
      entitled: true,
    });
    const mechanisms = { linux: "linux-bubblewrap", darwin: "macos-seatbelt", win32: "windows-appcontainer" } as const;
    const ready: ConfinementStatus = {
      available: true,
      sourceAccess: "core-only",
      reason: null,
      network: "on",
      detail: "AD-58 scratch",
      mechanism: mechanisms[process.platform as keyof typeof mechanisms],
    };
    const refresh = vi.spyOn(CrotCore.prototype, "refreshConfinement").mockResolvedValue(ready);
    const f = await publicationFixture({ productionGate: true });
    cleanup.push(f.close);
    const draft = await f.prepare();
    expect(draft.state).toBe("pending_publication");
    const opened = await ownerRequest<{ confirmation: string }>(f.owner, "publications.open", { id: draft.id });
    refresh.mockResolvedValue({ ...ready, available: false, reason: "self_test_failed" });
    await expect(f.prepare()).rejects.toThrow("fresh native credential/control isolation");
    await f.owner.request("publications.confirm", fields(draft.id, opened.confirmation));
    await waitFor(
      async () => (await ownerRequest<Rows>(f.owner, "publications.list")).publications[0]?.state === "failed",
    );
    expect(f.writes()).toBe(0);
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
  },
);
