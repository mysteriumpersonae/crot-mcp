/** Private, real Secret Service fixture. Never uses the runner's login keyring. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function startLinuxSecretSession(state: string) {
  for (const executable of ["dbus-daemon", "dbus-send", "gnome-keyring-daemon", "secret-tool"])
    await access("/usr/bin/" + executable, constants.X_OK);
  const home = path.join(state, "secret-home"),
    runtime = path.join(state, "secret-runtime");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(state, "secret-bus")}`,
    GNOME_KEYRING_CONTROL: path.join(state, "keyring"),
  } as NodeJS.ProcessEnv;
  for (const key of ["DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "GNOME_KEYRING_PID", "SESSION_MANAGER"])
    delete env[key];
  for (const dir of [home, runtime, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_CACHE_HOME!])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  const children: ChildProcess[] = [];
  const close = async () => {
    for (const child of children.slice().reverse()) {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        child.once("exit", done);
        child.once("error", done);
        child.kill();
      });
    }
  };
  const launch = (file: string, args: string[]) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let output = "",
      diagnostics = "",
      startError = "";
    child.stdout!.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-2048);
    });
    child.stderr!.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-1024);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      startError = error.code ?? "SPAWN_FAILED";
    });
    child.stdin!.on("error", () => undefined);
    return {
      child,
      output: () => output,
      assertRunning() {
        if (startError || child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `${path.basename(file)} stopped (code=${child.exitCode}, signal=${child.signalCode}, start=${startError})`,
          );
      },
      // Startup-only diagnostics: no credential has been written at this point.
      diagnostics: () => diagnostics.replace(/[\r\n]+/g, " ").slice(0, 400),
    };
  };
  const wait = async (
    phase: string,
    check: () => Promise<boolean> | boolean,
    timeout: number,
    details: () => string,
  ) => {
    try {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("readiness deadline exceeded");
    } catch (error) {
      throw new Error(`Secret Service fixture: ${phase}: ${(error as Error).message}; ${details()}`);
    }
  };
  try {
    const bus = launch("/usr/bin/dbus-daemon", [
      "--session",
      "--nofork",
      "--print-address=1",
      "--address=" + env.DBUS_SESSION_BUS_ADDRESS!,
    ]);
    bus.child.stdin!.end();
    await wait(
      "private D-Bus startup",
      () => {
        bus.assertRunning();
        return bus.output().includes(env.DBUS_SESSION_BUS_ADDRESS!);
      },
      5000,
      bus.diagnostics,
    );
    const keyring = launch("/usr/bin/gnome-keyring-daemon", [
      "--foreground",
      "--unlock",
      "--components=secrets",
      "--control-directory=" + env.GNOME_KEYRING_CONTROL!,
    ]);
    keyring.child.stdin!.end("crot-test-only-password\n");
    // NameHasOwner does NOT activate a competing, locked daemon. secret-tool
    // must not run until our explicitly unlocked daemon owns this private bus.
    await wait(
      "org.freedesktop.secrets registration",
      async () => {
        bus.assertRunning();
        keyring.assertRunning();
        try {
          const result = await exec(
            "/usr/bin/dbus-send",
            [
              "--session",
              "--type=method_call",
              "--print-reply",
              "--dest=org.freedesktop.DBus",
              "/org/freedesktop/DBus",
              "org.freedesktop.DBus.NameHasOwner",
              "string:org.freedesktop.secrets",
            ],
            { env, timeout: 2000 },
          );
          return /boolean\s+true\b/.test(result.stdout);
        } catch {
          return false;
        }
      },
      15000,
      () => bus.diagnostics() + " " + keyring.diagnostics(),
    );
    return { env, close };
  } catch (error) {
    await close();
    throw error;
  }
}
