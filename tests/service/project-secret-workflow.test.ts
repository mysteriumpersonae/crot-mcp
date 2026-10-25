import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { TrayToolClient } from "../../src/tray/tool-client.js";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import {
  makeTempDirs,
  makeServiceHost,
  type ServiceHost,
  type TempDirs,
  waitFor,
  isAlive,
  stopService,
} from "../helpers.js";
const bin = inject("crotMcpBin");
let dirs: TempDirs, host: ServiceHost, client: TrayToolClient, control: ControlClient | undefined;
afterEach(async () => {
  control?.close();
  await client?.close();
  await host?.cleanup(bin);
  await dirs?.cleanup();
});
it(
  "AD-58 owner grant stays Core-only; revoke drains private actors or preserves fail-closed launch refusal across restart",
  { timeout: 90000 },
  async () => {
    dirs = await makeTempDirs();
    host = await makeServiceHost(dirs.outside);
    const config = path.join(dirs.outside, "config.json"),
      audit = path.join(dirs.outside, "audit.jsonl");
    await writeFile(
      config,
      JSON.stringify({
        workspace: { root: dirs.workspace },
        permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
        audit: { sink: "file", path: audit },
      }),
    );
    await writeFile(path.join(dirs.workspace, ".env"), "UNLOGGED_SECRET_VALUE");
    await writeFile(path.join(dirs.workspace, "other.pem"), "OTHER_PRIVATE");
    const connect = async () => {
      client = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env: host.env });
      await call("crot_status");
      control = await ControlClient.connect({
        stateDir: host.stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
      });
      expect(control).toBeDefined();
    };
    const call = async (name: string, args: unknown = {}) => {
      const r = (await client.call(name, args)) as { isError?: boolean; content: { text?: string }[] };
      if (r.isError) throw Error(JSON.stringify(r));
      return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
    };
    const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}) =>
      (await control!.request(
        method as import("../../src/service/protocol.js").ControlRequest["method"],
        params,
      )) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    await connect();
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
    await expect(
      rpc("security.secretFiles.set", { workspace: dirs.outside, path: ".env", allow: true }),
    ).rejects.toThrow();
    expect(
      (await rpc("security.secretFiles.set", { workspace: dirs.workspace, path: ".env", allow: true })).drained,
    ).toBe(true);
    expect((await call("fs_read_file", { path: ".env" })).content).toBe("UNLOGGED_SECRET_VALUE");
    await expect(call("fs_read_file", { path: "other.pem" })).rejects.toThrow("PERMISSION_DENIED");
    const status = (await call("crot_status")) as { confinement: { available: boolean; sourceAccess: string } };
    expect(status.confinement.sourceAccess).toBe("core-only");
    let pid: number | undefined;
    const start = () => call("process_start", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    if (status.confinement.available) {
      const probe = await call("process_exec", {
        command: process.execPath,
        args: [
          "-e",
          `try{require('fs').readFileSync(${JSON.stringify(path.join(dirs.workspace, ".env"))});process.exit(9)}catch(e){if(!['EACCES','EPERM','ENOENT'].includes(e.code))throw e;console.log('denied')}`,
        ],
      });
      expect(probe.exitCode).toBe(0);
      const started = await start();
      pid = started.pid as number;
      expect(isAlive(pid)).toBe(true);
    } else await expect(start()).rejects.toThrow("CONFINEMENT_UNAVAILABLE");
    const result = await rpc("security.secretFiles.set", { workspace: dirs.workspace, path: ".env", allow: false });
    expect(result.drained).toBe(true);
    if (pid !== undefined) await waitFor(() => !isAlive(pid!));
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
    // The same transport continues through the new Core; revocation is not a permanent emergency stop.
    expect(
      (await call("fs_write_file", { path: "public.txt", content: "still working" })).bytesWritten,
    ).toBeGreaterThan(0);
    const state = await rpc("security.secretFiles.status");
    expect(state.policy.allow).toEqual([]);
    expect(state.halted).toBe(false);
    const records = await readFile(audit, "utf8");
    expect(records).toContain('"action":"project_secret_access"');
    expect(records).not.toContain("UNLOGGED_SECRET_VALUE");
    control!.close();
    control = undefined;
    await client.close();
    await stopService(bin, host.env);
    await connect();
    expect((await rpc("security.secretFiles.status")).policy.allow).toEqual([]);
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
  },
);
