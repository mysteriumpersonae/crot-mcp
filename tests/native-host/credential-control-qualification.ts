/** Actual OS-store canary + shipped service/control + AD-58 command launches.
 * No missing-item, loader-failure or memory-backend substitute is acceptance evidence. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { ServeCommand } from "../../src/cli/options.js";
import { CrotService } from "../../src/service/service.js";
import { ControlClient } from "../../src/service/control-client.js";
import { secretCredentialStore, serviceEndpoint } from "../../src/service/endpoints.js";
import { createServicePrivateFiles } from "../../src/service/private-files.js";
import { AccountSecrets } from "../../src/service/social/account-secrets.js";
import { createCredentialManager } from "../../src/service/social/credential-manager.js";
import { createKeychainBackend, createLibsecretBackend, stateKey } from "../../src/service/secrets/backends.js";
import type { SecretName } from "../../src/service/secrets/types.js";
import { testContext, waitFor } from "../helpers.js";
import { buildLocalShimFixture } from "./windows-l1/diagnostics/local-shim-build.js";
import { buildCredentialProbe } from "./windows-l1/diagnostics/credential-probe-build.js";
const exec = promisify(execFile);
export async function qualifyCredentialControl(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-auth-")));
  const state = path.join(root, "s"),
    workspace = path.join(root, "w");
  const privateFiles = createServicePrivateFiles(process.platform === "win32");
  let service: CrotService | undefined, owner: ControlClient | undefined;
  let shim: Awaited<ReturnType<typeof buildLocalShimFixture>> | undefined;
  let probe: Awaited<ReturnType<typeof buildCredentialProbe>> | undefined;
  const children: ChildProcess[] = [],
    cleanup: Array<() => Promise<unknown>> = [];
  const canary = "qualification-only-" + randomUUID();
  let read: () => Promise<string | undefined>, remove: () => Promise<void>;
  let secretScript: string;
  try {
    await mkdir(workspace);
    await privateFiles.ensureDirectory(state);
    if (process.platform === "win32") {
      shim = await buildLocalShimFixture();
      probe = await buildCredentialProbe();
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
      await exec(powershell, [...ps, path.resolve("scripts/l1-install-win.ps1"), "-Apply"], { timeout: 120000 });
      await exec(
        powershell,
        [
          ...ps,
          path.resolve("scripts/l1-components-win.ps1"),
          "-StateDirectory",
          state,
          "-NodeExecutable",
          process.execPath,
          "-Library",
          shim.library,
        ],
        { timeout: 120000 },
      );
      const secrets = new AccountSecrets(await createCredentialManager(state));
      await secrets.write("github", "access", canary);
      read = () => secrets.read("github", "access");
      remove = () => secrets.clear("github");
      cleanup.push(remove);
      const target = `crot.accounts:${stateKey(state)}:github:access`;
      const host = await exec(probe.executable, [target]);
      expect(JSON.parse(host.stdout)).toEqual({ read: true, error: 0 });
      await copyFile(probe.executable, path.join(workspace, "credential-probe.exe"));
      secretScript = `const r=cp.spawnSync(p.join(process.cwd(),'credential-probe.exe'),[${JSON.stringify(target)}],{encoding:'utf8',timeout:10000});if(r.error||r.status!==0)throw Error('native credential probe failed to run');const v=JSON.parse(r.stdout);if(v.read||![5,1168,1312].includes(v.error))throw Error('CredReadW isolation failed');`;
    } else if (process.platform === "darwin") {
      const keychain = path.join(state, "qualification.keychain-db");
      await exec("/usr/bin/security", ["create-keychain", "-p", "crot-test-only-password", keychain]);
      cleanup.push(() => exec("/usr/bin/security", ["delete-keychain", keychain]));
      const backend = createKeychainBackend(state, { keychain });
      const name = "oauth-github-access" as SecretName;
      await backend.set(name, canary);
      read = () => backend.get(name);
      remove = () => backend.delete(name);
      cleanup.push(remove);
      const args = ["find-generic-password", "-s", `crot-mcp:${stateKey(state)}`, "-a", name, "-w", keychain];
      secretScript = `const r=cp.spawnSync('/usr/bin/security',${JSON.stringify(args)},{encoding:'utf8',timeout:10000});if(r.error||r.status===null||r.status===0||r.stdout.trim())throw Error('Keychain isolation failed');`;
    } else {
      // Private real D-Bus/gnome-keyring session; never touches the user's vault.
      for (const executable of ["dbus-daemon", "gnome-keyring-daemon", "secret-tool"])
        await access("/usr/bin/" + executable, constants.X_OK).catch(() => {
          throw new Error("Native Secret Service qualification needs CI dependency: " + executable);
        });
      const address = `unix:path=${path.join(state, "secret-bus")}`;
      const daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1", "--address=" + address], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(daemon);
      let busReady = false;
      daemon.stdout!.on("data", () => {
        busReady = true;
      });
      await waitFor(() => busReady, 5000);
      const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address };
      const keyring = spawn(
        "gnome-keyring-daemon",
        ["--foreground", "--unlock", "--components=secrets", "--control-directory=" + path.join(state, "keyring")],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(keyring);
      keyring.stdin!.end("crot-test-only-password\n");
      const backend = createLibsecretBackend(state, { tool: "/usr/bin/secret-tool", env });
      const name = "oauth-github-access" as SecretName;
      await waitFor(async () => {
        try {
          await backend.set(name, canary);
          return true;
        } catch {
          return false;
        }
      }, 15000);
      read = () => backend.get(name);
      remove = () => backend.delete(name);
      cleanup.push(remove);
      const args = ["lookup", "application", "crot-mcp", "crot-state", stateKey(state), "crot-secret", name];
      // Give the malicious child the true address: environment filtering alone is not proof.
      secretScript = `const r=cp.spawnSync('/usr/bin/secret-tool',${JSON.stringify(args)},{env:{PATH:'/usr/bin:/bin',DBUS_SESSION_BUS_ADDRESS:${JSON.stringify(address)}},encoding:'utf8',timeout:10000});if(r.error||r.status===null||r.status===0||r.stdout.trim()||!r.stderr.trim())throw Error('Secret Service isolation failed');`;
    }
    expect(await read!()).toBe(canary);
    const started = await CrotService.start({
      command: {
        kind: "serve",
        warnings: [],
        config: {
          workspace: { root: workspace },
          environment: { path: "inherited" },
          permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
          confinement: { network: "on" },
          secrets: { store: "file" },
          audit: { sink: "file", path: path.join(state, "audit.jsonl") },
        } as ServeCommand["config"],
      },
      launch: "managed",
      stateDir: state,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
      identity: { environment: { unavailable: "native credential/control qualification" } },
    });
    if (started === "already_running") throw Error("unexpected existing service");
    service = started;
    expect(service.core.confinementStatus()).toMatchObject({
      available: true,
      sourceAccess: "core-only",
      network: "on",
    });
    owner = await ControlClient.connect({ stateDir: state, privateFiles });
    if (!owner) throw Error("owner connection unavailable");
    expect(await owner.request("ping")).toMatchObject({ state: "running" });
    const credential = await secretCredentialStore(state, privateFiles).read("control");
    if (!credential) throw Error("actual owner credential missing");
    const endpoint = serviceEndpoint(state, "control", credential).path;
    const credentialFile = path.join(state, "control-token");
    expect((await readFile(credentialFile)).length).toBeGreaterThan(0);
    const code = `const cp=require('child_process'),p=require('path'),net=require('net'),fs=require('fs');
for(const name of Object.keys(process.env)){if(/^(CROT_|OAUTH_|OWNER_RPC_|DBUS_SESSION_BUS_ADDRESS$)/i.test(name))throw Error('reserved service environment inherited')}
try{fs.readFileSync(${JSON.stringify(credentialFile)});throw Error('owner credential file readable')}catch(e){if(!['EACCES','EPERM','ENOENT','ENOTDIR'].includes(e.code))throw e}
${secretScript!}
const s=net.connect(${JSON.stringify(endpoint)});s.setTimeout(5000,()=>{console.error('owner probe timed out');process.exit(93)});s.on('connect',()=>{s.destroy();console.error('owner channel reachable');process.exit(94)});s.on('error',e=>{if(!['EACCES','EPERM','ENOENT','ENOTDIR'].includes(e.code)){console.error(e.code);process.exit(95)}console.log('CREDENTIAL-CONTROL-ISOLATED');});`;
    for (const kind of ["terminal", "custom-skill"]) {
      const input = {
        command: process.platform === "win32" ? "node" : process.execPath,
        args: ["-e", code],
        timeoutMs: 30000,
      };
      const result =
        kind === "terminal"
          ? await service.core.processes.exec(testContext, input)
          : await service.core.processes.execInScratch(testContext, input, ".");
      expect(result.stderr, kind).not.toContain(canary);
      expect(result.stdout, kind).not.toContain(canary);
      expect(result, kind).toMatchObject({ exitCode: 0, timedOut: false });
      expect(result.stdout, kind).toContain("CREDENTIAL-CONTROL-ISOLATED");
      expect(await read!()).toBe(canary);
      expect(await owner.request("ping")).toMatchObject({ state: "running" });
    }
    expect(await readFile(path.join(state, "audit.jsonl"), "utf8")).not.toContain(canary);
  } finally {
    owner?.close();
    await service?.shutdown("credential/control qualification");
    for (const close of cleanup.reverse()) await close();
    for (const child of children.reverse()) {
      child.kill();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((r) => child.once("exit", () => r()));
    }
    await probe?.cleanup();
    await shim?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    "CROT-native-credential-control",
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      terminal: "denied",
      customSkill: "denied",
      ownerPositiveControl: true,
      credentialPositiveControl: true,
    }),
  );
}
