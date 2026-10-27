/** AD-58: empty private command cwd + native denial of the entire live source. */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import { readWorkspaceArtifacts, ArtifactPathSchema } from "./workspace-artifacts.js";
import path from "node:path";
import { prepareScratchDirectory, ScratchDirectorySchema } from "./scratch-directory.js";
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
    ...(current?.exportPending ? { available: false, reason: "artifact_export_pending" as const } : {}),
    detail: [
      ...(current?.exportPending
        ? ["Artifact export pending: retry export before commands/source writes; scratch is retained"]
        : [s.detail]),
      "AD-58: commands use empty private scratch; source files are accessed only by checked Core operations; writes drain actors; no automatic import",
    ]
      .filter(Boolean)
      .join("; "),
  });
  type Generation = {
    root: string;
    scratch: string;
    native: CoreConfinement;
    nativeReady?: boolean;
    exportPending?: boolean;
  };
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
    if (current?.nativeReady !== false) current?.native.assertAdmission?.();
  };
  const checkCwd = (cwd: string) => {
    assert();
    if (!workspace.rules.equals(cwd, workspace.root, workspace.caseSensitive))
      throw blocked("only the project-root cwd is supported; nested/source cwd is not mounted");
  };
  const openNative = async (scratch: string) => {
    if (!platform.confinement) throw confinementUnavailableError(annotate(last));
    await prepareScratchDirectory(scratch, ".");
    return platform.confinement.open({
      ...scope,
      workspace: scratch,
      projectSecretAllowedPaths: [],
      protectedPaths: [...new Set([...scope.protectedPaths, workspace.root])],
    });
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
      if (platform.confinement.createScratchDirectory) await platform.confinement.createScratchDirectory(scratch);
      else await mkdir(scratch, { mode: 0o700 });
      const native = await openNative(scratch);
      return { root, scratch, native, nativeReady: true };
    } catch (cause) {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw cause;
    }
  };
  const ensure = async () => {
    if (current?.exportPending) throw blocked("artifact export is pending; retry export before launching commands");
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
    if (current.nativeReady === false) {
      current.native = await openNative(current.scratch);
      current.nativeReady = true;
      last = current.native.status();
      control = current.native.launcher.processControl;
      orphaned = current.native.launcher.canTerminateOrphanedDescendants;
    }
    assert();
    if (!last.available) throw confinementUnavailableError(annotate(last));
    return current;
  };
  const retire = async () => {
    const owned = current;
    if (!owned) return;
    if (owned.exportPending) throw blocked("artifact export pending; source mutation must not discard results");
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
    launchScratch: (command, args, options, relativeDirectory) =>
      serial(async () => {
        const relative = ScratchDirectorySchema.parse(relativeDirectory);
        const g = await ensure();
        try {
          await g.native.close();
        } catch (error) {
          fault = error;
          last = { ...last, available: false, reason: "self_test_failed", detail: "Scratch cwd actor drain failed" };
          throw error;
        }
        g.nativeReady = false;
        // No sandbox actor remains; admission stays locked through canonical
        // validation, native re-confinement, executable resolution and spawn.
        const cwd = await prepareScratchDirectory(g.scratch, relative);
        g.native = await openNative(g.scratch);
        g.nativeReady = true;
        last = g.native.status();
        if (!last.available) throw confinementUnavailableError(annotate(last));
        const spec = await g.native.launcher.resolveCommand(command, args, { cwd, env: options.env });
        const proc = await g.native.launcher.launch(spec, { ...options, cwd });
        if (closing) {
          await proc.terminate("force");
          throw blocked("closed during scratch launch");
        }
        return proc;
      }),
    assertAdmission: assert,
    status: () => annotate(last),
    refresh: () =>
      serial(async () => {
        assert();
        if (current?.nativeReady === false) await ensure();
        last = current
          ? await current.native.refresh()
          : platform.confinement
            ? await platform.confinement.probe(scope.network)
            : last;
        return annotate(last);
      }),
    artifactState: () => ({
      pending: current?.exportPending === true,
      ...(current?.exportPending ? { recoveryDirectory: current.scratch } : {}),
    }),
    exportArtifacts: <T>(
      files: readonly string[],
      commit: (files: import("./workspace-artifacts.js").ArtifactSnapshot[]) => Promise<T>,
    ) =>
      serial(async () => {
        if (closing || fault) throw blocked("workspace is closing or native teardown failed");
        for (const file of files) ArtifactPathSchema.parse(file);
        const owned = current;
        if (!owned) throw blocked("no command workspace is available for export");
        if (!owned.exportPending) {
          try {
            await owned.native.close();
          } catch (cause) {
            fault = cause;
            last = {
              ...last,
              available: false,
              reason: "self_test_failed",
              detail: "Artifact export could not drain native actors",
            };
            throw cause;
          }
          owned.exportPending = true;
        }
        // Retain all scratch on any validation/authorization/commit failure.
        // Retry can choose remaining files or explicitly permit replacement.
        const snapshots = await readWorkspaceArtifacts(owned.scratch, files);
        const result = await commit(snapshots);
        await rm(owned.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        current = undefined;
        return result;
      }),
    withSourceMutation: <T>(execute: () => Promise<T>) =>
      serial(async () => {
        if (current?.exportPending) throw blocked("artifact export pending; retry export before source writes");
        assert();
        await retire();
        assert();
        return execute();
      }),
    close: () => {
      closing = true;
      return (closed ??= serial(async () => {
        if (current?.exportPending) {
          await current.native.close();
          current = undefined;
          return;
        }
        await retire();
      }));
    },
    closeSync: () => {
      closing = true;
      if (current) {
        current.native.closeSync();
        if (!current.exportPending)
          rmSync(current.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        current = undefined;
      }
    },
  };
}
