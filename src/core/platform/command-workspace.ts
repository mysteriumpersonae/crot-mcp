/** AD-58: empty private command cwd + native denial of the entire live source. */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrotError } from "../errors.js";
import type { Workspace } from "../workspace/workspace.js";
import { unavailableConfinement, confinementUnavailableError } from "./confinement.js";
import type {
  CommandSpec,
  ConfinementScope,
  ConfinementStatus,
  CoreConfinement,
  Platform,
  ProcessLauncher,
} from "./types.js";

const blocked = (message: string) =>
  new CrotError("CONFINEMENT_FAILED", `AD-58 command workspace: ${message}; no unconfined retry`);
export async function openCommandWorkspace(
  platform: Platform,
  workspace: Workspace,
  scope: ConfinementScope,
): Promise<CoreConfinement> {
  const annotate = (s: ConfinementStatus): ConfinementStatus => ({
    ...s,
    sourceAccess: "core-only",
    detail: [
      s.detail,
      "AD-58: commands use empty private scratch; source files are accessed only by checked Core operations; writes drain actors; no automatic import",
    ]
      .filter(Boolean)
      .join("; "),
  });
  type Generation = { root: string; scratch: string; native: CoreConfinement };
  let current: Generation | undefined,
    closing = false,
    fault: unknown,
    closed: Promise<void> | undefined;
  let last = unavailableConfinement(scope.network).status();
  let control = platform.launcher.processControl,
    orphaned = platform.launcher.canTerminateOrphanedDescendants;
  let tail: Promise<unknown> = Promise.resolve();
  const bindings = new WeakMap<CommandSpec, Generation>();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action);
    tail = next.catch(() => undefined);
    return next;
  };
  const assert = () => {
    if (closing) throw blocked("workspace is closing");
    if (fault) throw blocked("native teardown failed; source mutation and new commands refused");
    current?.native.assertAdmission?.();
  };
  const checkCwd = (cwd: string) => {
    assert();
    if (!workspace.rules.equals(cwd, workspace.root, workspace.caseSensitive))
      throw blocked("only the project-root cwd is supported; nested/source cwd is not mounted");
  };
  const prepare = async (): Promise<Generation> => {
    if (!platform.confinement) throw confinementUnavailableError(annotate(last));
    let root: string | undefined;
    try {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-commands-")));
      if (workspace.contains(workspace.root, root) || workspace.contains(root, workspace.root))
        throw blocked("source overlaps private storage");
      // Native Windows protection intentionally does not adopt/re-ACL an
      // existing directory. mkdtemp's container is ours, but create a NEW
      // private child through the native provider, then verify that child.
      const privateRoot = path.join(root, "private");
      await platform.privateFiles.ensureDirectory(privateRoot);
      if (!(await platform.privateFiles.inspect(privateRoot)).ownerOnly)
        throw blocked("private storage is not owner-only");
      const scratch = path.join(privateRoot, "work");
      await mkdir(scratch, { mode: 0o700 });
      const native = await platform.confinement.open({
        ...scope,
        workspace: scratch,
        projectSecretAllowedPaths: [],
        protectedPaths: [...new Set([...scope.protectedPaths, workspace.root])],
      });
      return { root, scratch, native };
    } catch (cause) {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw cause;
    }
  };
  const ensure = async () => {
    assert();
    if (!current) {
      try {
        current = await prepare();
        last = current.native.status();
        control = current.native.launcher.processControl;
        orphaned = current.native.launcher.canTerminateOrphanedDescendants;
      } catch (cause) {
        last = unavailableConfinement(
          scope.network,
          "private_storage_unavailable",
          cause instanceof CrotError ? cause.message : "AD-58 command workspace could not be prepared",
        ).status();
        throw confinementUnavailableError(annotate(last));
      }
    }
    assert();
    if (!last.available) throw confinementUnavailableError(annotate(last));
    return current;
  };
  const retire = async () => {
    const owned = current;
    if (!owned) return;
    try {
      // Native close drains/verifies every owned actor BEFORE ACL restore.
      // Do not remove scratch or permit a source mutation if this fails.
      await owned.native.close();
      await rm(owned.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      current = undefined;
    } catch (cause) {
      fault = cause;
      last = {
        ...last,
        available: false,
        reason: "self_test_failed",
        detail: "AD-58 actor drain or workspace teardown failed",
      };
      throw cause;
    }
  };
  // Report readiness at Core creation; launch remains lazy inside the native backend.
  try {
    current = await prepare();
    last = current.native.status();
    control = current.native.launcher.processControl;
    orphaned = current.native.launcher.canTerminateOrphanedDescendants;
  } catch (cause) {
    last = unavailableConfinement(
      scope.network,
      platform.confinement ? "private_storage_unavailable" : "not_implemented",
      cause instanceof CrotError ? cause.message : "AD-58 native command storage unavailable",
    ).status();
  }
  const launcher: ProcessLauncher = {
    get canTerminateOrphanedDescendants() {
      return orphaned;
    },
    get processControl() {
      return control;
    },
    resolveCommand: (command, args, options) =>
      serial(async () => {
        checkCwd(options.cwd);
        const g = await ensure();
        const spec = await g.native.launcher.resolveCommand(command, args, { ...options, cwd: g.scratch });
        bindings.set(spec, g);
        return spec;
      }),
    launch: (spec, options) =>
      serial(async () => {
        checkCwd(options.cwd);
        const g = await ensure();
        if (bindings.has(spec) && bindings.get(spec) !== g)
          throw blocked("resolved command belongs to a retired generation");
        const proc = await g.native.launcher.launch(spec, { ...options, cwd: g.scratch });
        if (closing) {
          await proc.terminate("force");
          throw blocked("closed during launch");
        }
        return proc;
      }),
  };
  return {
    launcher,
    assertAdmission: assert,
    status: () => annotate(last),
    refresh: () =>
      serial(async () => {
        assert();
        last = current
          ? await current.native.refresh()
          : platform.confinement
            ? await platform.confinement.probe(scope.network)
            : last;
        return annotate(last);
      }),
    withSourceMutation: <T>(execute: () => Promise<T>) =>
      serial(async () => {
        assert();
        await retire();
        assert();
        return execute();
      }),
    close: () => {
      closing = true;
      return (closed ??= serial(async () => {
        await retire();
      }));
    },
    closeSync: () => {
      closing = true;
      if (current) {
        current.native.closeSync();
        rmSync(current.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        current = undefined;
      }
    },
  };
}
