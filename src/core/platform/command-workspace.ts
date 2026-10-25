/** AD-58: empty private command cwd + native denial of the entire live source. */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrotError } from "../errors.js";
import type { Workspace } from "../workspace/workspace.js";
import { unavailableConfinement } from "./confinement.js";
import type { ConfinementScope, ConfinementStatus, CoreConfinement, Platform, ProcessLauncher } from "./types.js";

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
      "AD-58: commands use empty private scratch; source files are accessed only by checked Core operations; no automatic import",
    ]
      .filter(Boolean)
      .join("; "),
  });
  if (!platform.confinement) {
    const absent = unavailableConfinement(scope.network);
    return {
      ...absent,
      status: () => annotate(absent.status()),
      refresh: async () => annotate(await absent.refresh()),
    };
  }
  let root: string | undefined;
  try {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-commands-")));
    if (workspace.contains(workspace.root, root) || workspace.contains(root, workspace.root))
      throw blocked("source overlaps private storage");
    await platform.privateFiles.ensureDirectory(root);
    if (!(await platform.privateFiles.inspect(root)).ownerOnly) throw blocked("private storage is not owner-only");
    const scratch = path.join(root, "work");
    await mkdir(scratch, { mode: 0o700 });
    const native = await platform.confinement.open({
      ...scope,
      workspace: scratch,
      projectSecretAllowedPaths: [],
      protectedPaths: [...new Set([...scope.protectedPaths, workspace.root])],
    });
    let closing = false,
      closed: Promise<void> | undefined;
    const assert = () => {
      if (closing) throw blocked("workspace is closing");
      native.assertAdmission?.();
    };
    const map = (cwd: string) => {
      assert();
      if (!workspace.rules.equals(cwd, workspace.root, workspace.caseSensitive))
        throw blocked("only the project-root cwd is supported; nested/source cwd is not mounted");
      return scratch;
    };
    const launcher: ProcessLauncher = {
      canTerminateOrphanedDescendants: native.launcher.canTerminateOrphanedDescendants,
      processControl: native.launcher.processControl,
      resolveCommand: (command, args, options) =>
        native.launcher.resolveCommand(command, args, { ...options, cwd: map(options.cwd) }),
      launch: (spec, options) => native.launcher.launch(spec, { ...options, cwd: map(options.cwd) }),
    };
    const owned = root;
    return {
      launcher,
      assertAdmission: assert,
      status: () => annotate(native.status()),
      refresh: async () => {
        assert();
        return annotate(await native.refresh());
      },
      close: () =>
        (closed ??= (async () => {
          closing = true;
          await native.close();
          await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        })()),
      closeSync: () => {
        closing = true;
        native.closeSync();
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (cause) {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const absent = unavailableConfinement(
      scope.network,
      "private_storage_unavailable",
      cause instanceof CrotError ? cause.message : "AD-58 command workspace could not be prepared",
    );
    return {
      ...absent,
      status: () => annotate(absent.status()),
      refresh: async () => annotate(await absent.refresh()),
    };
  }
}
