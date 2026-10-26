import { afterEach, expect, it } from "vitest";
import { access } from "node:fs/promises";
import path from "node:path";
import { RemoteAcceptance, eventually } from "./harness.js";
import { connectClient, versions, type AcceptanceClient } from "./client.js";
let h: RemoteAcceptance | undefined;
const clients: AcceptanceClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await h?.stop();
  h = undefined;
});
it("OD-5 real device abort is 5 seconds before relay deadline, no pending write executes", async () => {
  h = new RemoteAcceptance();
  // Keep the production 5-second device/relay margin, but give real Windows
  // TLS/ACL/owner-event admission time to reach the pending approval first.
  // A 6000ms relay budget left only 1000ms and could test pre-admission expiry
  // instead of cancellation of a pending write. This changes the fixture only.
  await h.start({ gateWrites: true, exchangeDeadlineMs: 12000 });
  h.autoApprove = false;
  const c = await connectClient(h, "2026-07-28");
  clients.push(c);
  const start = performance.now();
  // Attach the rejection handler before awaiting owner delivery: an early
  // transport failure must not become an unhandled rejection or a false Pass.
  const rejected = expect(
    c.call("fs_write_file", { path: "must-not-exist.txt", content: "WP32_DEADLINE_CANARY" }),
  ).rejects.toThrow();
  await eventually(() => h!.approvals.length === 1, 5000, "pending write approval before device deadline");
  await rejected;
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThan(6500);
  expect(elapsed).toBeLessThan(9500);
  expect(h.approvals).toHaveLength(1);
  await expect(access(path.join(h.workspace, "must-not-exist.txt"))).rejects.toThrow();
  await eventually(() => h!.relay.status().openStreams === 0);
  expect(JSON.stringify(h.logs)).toContain("deadline_exceeded");
  console.log(`WP32_TIMEOUT device-deadline: relay=12000ms margin=5000ms measured=${Math.round(elapsed)}ms`);
}, 20000);
it("OD-5 default SDK waits terminate at the earlier production approval expiry for all revisions", async () => {
  h = new RemoteAcceptance();
  await h.start({ gateWrites: true });
  h.autoApprove = false;
  for (const version of versions)
    clients.push(
      await connectClient(
        h,
        version,
        h.as.token({ resource: h.uri, sub: "user_01", clientId: "wp32-timeout-" + version }),
      ),
    );
  await Promise.all(
    clients.map(async (c, index) => {
      const start = performance.now();
      const result = await c.call("fs_write_file", { path: `timeout-${index}.txt`, content: "WP32_TIMEOUT_CANARY" });
      expect(JSON.stringify(result)).toMatch(/PERMISSION_DENIED/);
      expect(JSON.stringify(result)).toMatch(/expired/);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThan(43000);
      expect(elapsed).toBeLessThan(55000);
      await expect(access(path.join(h!.workspace, `timeout-${index}.txt`))).rejects.toThrow();
      console.log(
        `WP32_TIMEOUT ${versions[index]} SDK-default(60000ms), approval-expiry measured=${Math.round(elapsed)}ms`,
      );
    }),
  );
  expect(h.approvals).toHaveLength(3);
}, 75000);
it("OD-5 explicit SDK timeout is measured and cancels earlier than approval/deadline", async () => {
  h = new RemoteAcceptance();
  await h.start({ gateWrites: true });
  h.autoApprove = false;
  for (const version of versions) {
    const c = await connectClient(
      h,
      version,
      h.as.token({ resource: h.uri, sub: "user_01", clientId: "wp32-sdk-" + version }),
    );
    clients.push(c);
    const start = performance.now();
    await expect(
      c.call("fs_write_file", { path: "sdk-cancel-" + version, content: "WP32_TIMEOUT_CANARY" }, 300),
    ).rejects.toThrow(/timed out|timeout/i);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThan(250);
    expect(elapsed).toBeLessThan(2500);
    await expect(access(path.join(h.workspace, "sdk-cancel-" + version))).rejects.toThrow();
    console.log(`WP32_TIMEOUT ${version} SDK-explicit=300ms measured=${Math.round(elapsed)}ms`);
    await c.close();
  }
}, 15000);
