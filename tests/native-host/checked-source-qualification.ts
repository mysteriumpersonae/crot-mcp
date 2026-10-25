/** AD-58 real native acceptance shared by the three mandatory platform suites. */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import type { ManagedProcess } from "../../src/core/platform/types.js";
import { NativeHost } from "../../src/native-host/native-host.js";
import { runTool, windowsTools } from "../../src/native-host/windows-acl.js";
import { createServicePrivateFiles } from "../../src/service/private-files.js";
import { createTestCore, makeTempDirs, testContext, waitFor } from "../helpers.js";
import { buildLocalShimFixture } from "./windows-l1/diagnostics/local-shim-build.js";

export async function qualifyCheckedSource(): Promise<void> {
  const d = await makeTempDirs(),
    state = path.join(d.outside, "state");
  let native: NativeHost | undefined, core: CrotCore | undefined, child: ManagedProcess | undefined;
  let build: Awaited<ReturnType<typeof buildLocalShimFixture>> | undefined;
  const logs: string[] = [];
  try {
    const privateFiles = createServicePrivateFiles(process.platform === "win32");
    await privateFiles.ensureDirectory(state);
    if (process.platform === "win32") {
      build = await buildLocalShimFixture();
      const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
      const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
      await runTool(tools.powershell, [...ps, path.resolve("scripts/l1-install-win.ps1"), "-Apply"]);
      await runTool(tools.powershell, [
        ...ps,
        path.resolve("scripts/l1-components-win.ps1"),
        "-StateDirectory",
        state,
        "-NodeExecutable",
        process.execPath,
        "-Library",
        build.library,
      ]);
    }
    await writeFile(path.join(state, "control-canary"), "CONTROL-CANARY");
    await writeFile(path.join(d.workspace, "public.txt"), "public-before");
    await writeFile(path.join(d.workspace, ".env"), "EXISTING-CANARY");
    await mkdir(path.join(d.workspace, "certs"));
    await writeFile(path.join(d.workspace, "certs", "server.pem"), "PEM-CANARY");
    native = await NativeHost.start({ startupPath: "inherited", stateDir: state, log: (l) => logs.push(l) });
    core = await createTestCore(
      { workspace: { root: d.workspace }, permissions: { mode: "full_control" }, confinement: { network: "on" } },
      undefined,
      {
        checkedCommands: true,
        platform: native.platform,
        protectedPaths: [path.join(state, "control-canary")],
        secretPaths: [path.join(state, "control-canary")],
      },
    );
    if (!core.confinementStatus().available)
      throw new Error(
        "AD58 native preparation unavailable: " + JSON.stringify({ status: core.confinementStatus(), logs }),
      );
    expect(core.confinementStatus(), logs.join("\n")).toMatchObject({
      available: true,
      sourceAccess: "core-only",
      reason: null,
    });
    await core.filesystem.writeFile(testContext, { path: "public.txt", content: "checked-before" });
    expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("checked-before");
    const probePaths = ["public.txt", ".env", ".ENVbackup", ".env.atomic", "future.KEY", "certs/server.pem"].map((p) =>
      path.join(d.workspace, p),
    );
    probePaths.push(path.join(state, "control-canary"));
    const code = `const f=require('fs');process.stdin.resume();console.log('AD58-READY');process.stdin.once('data',()=>{try{let denied=0;const deny=fn=>{try{fn()}catch(e){if(['EACCES','EPERM','ENOENT','ENOTDIR'].includes(e.code)){denied++;return}throw e}throw Error('source escape')};for(const p of ${JSON.stringify(probePaths)}){deny(()=>f.readFileSync(p));deny(()=>f.writeFileSync(p,'bad'))}deny(()=>f.writeFileSync(${JSON.stringify(path.join(d.workspace, ".env.created"))},'bad'));f.writeFileSync('atomic.tmp','private');deny(()=>f.renameSync('atomic.tmp',${JSON.stringify(path.join(d.workspace, "public.txt"))}));f.writeFileSync('private-only.txt','private');console.log('AD58-RESULT '+JSON.stringify({denied,cwd:process.cwd(),private:f.readFileSync('private-only.txt','utf8')}));process.exit(0)}catch(e){console.error(e.message);process.exit(7)}});`;
    child = await core.processes.openTransport(testContext, {
      command: process.platform === "win32" ? "node" : process.execPath,
      args: ["-e", code],
      cwd: d.workspace,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (c) => {
      out = (out + String(c)).slice(-16000);
    });
    child.stderr.on("data", (c) => {
      err = (err + String(c)).slice(-4000);
    });
    await waitFor(() => out.includes("AD58-READY"), 30000);
    // The SAME actor is already running when the owner creates/reclassifies secrets.
    await writeFile(path.join(d.workspace, ".ENVbackup"), "FUTURE-CANARY");
    await writeFile(path.join(d.workspace, "future.KEY"), "KEY-CANARY");
    // Windows may pin an existing protected identity against OWNER rename.
    // A safe sharing refusal is not an actor bypass. Core commits drain that
    // lease below; Linux/macOS also exercise an actual live reclassification.
    try {
      await rename(path.join(d.workspace, "public.txt"), path.join(d.workspace, ".env.atomic"));
    } catch (cause) {
      if (
        process.platform !== "win32" ||
        !["EBUSY", "EPERM", "EACCES"].includes((cause as NodeJS.ErrnoException).code ?? "")
      )
        throw cause;
    }
    await writeFile(path.join(d.workspace, ".env.atomic"), "RECLASSIFIED-CANARY");
    await writeFile(path.join(d.workspace, "public.txt"), "host-public-replacement");
    child.stdin!.write("go\n");
    const result = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(Error("AD58 child timeout")), 30000);
        t.unref();
      }),
    ]);
    if (!child.stdout.readableEnded) await new Promise<void>((r) => child!.stdout.once("end", r));
    expect({ result, err, out }).toMatchObject({ result: { code: 0 } });
    const packet = JSON.parse(out.split("AD58-RESULT ")[1]!.trim());
    expect(packet.denied).toBe(probePaths.length * 2 + 2);
    expect(packet.cwd).not.toBe(d.workspace);
    expect(packet.private).toBe("private");
    for (const [name, content] of [
      [".env", "EXISTING-CANARY"],
      ["certs/server.pem", "PEM-CANARY"],
      [".ENVbackup", "FUTURE-CANARY"],
      ["future.KEY", "KEY-CANARY"],
      [".env.atomic", "RECLASSIFIED-CANARY"],
    ]) {
      expect(await readFile(path.join(d.workspace, name!), "utf8")).toBe(content);
      await expect(core.filesystem.readFile(testContext, { path: name! })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(core.filesystem.writeFile(testContext, { path: name!, content: "bad" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("host-public-replacement");
    await expect(access(path.join(d.workspace, "private-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(d.workspace, ".env.created"))).rejects.toMatchObject({ code: "ENOENT" });
    await core.filesystem.writeFile(testContext, { path: "atomic.tmp", content: "checked-after" });
    await core.filesystem.move(testContext, { from: "atomic.tmp", to: "public.txt", overwrite: true });
    expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("checked-after");
    expect(await readFile(path.join(state, "control-canary"), "utf8")).toBe("CONTROL-CANARY");
    const next = await core.processes.exec(testContext, {
      command: process.platform === "win32" ? "node" : process.execPath,
      args: [
        "-e",
        "const f=require('fs');if(f.existsSync('private-only.txt'))process.exit(8);f.writeFileSync('fresh.txt','ok');console.log('AD58-FRESH')",
      ],
    });
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain("AD58-FRESH");
    await expect(access(path.join(d.workspace, "fresh.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await child?.terminate("force");
    await core?.shutdown();
    await native?.close();
    await build?.cleanup();
    await d.cleanup();
  }
}
