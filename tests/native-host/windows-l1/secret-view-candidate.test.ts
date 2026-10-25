/** AD-55: real signed-driver data/control feasibility, NOT production L1. */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import { createNodePlatform } from "../../../src/core/platform/node-platform.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadViewJobObjectApi } from "../../../src/native-host/windows-job.js";
import { createOwnedWorkspaceView } from "../../../src/native-host/windows-l1/workspace-view.js";
import { snapshotWorkspaceDescriptor } from "./diagnostics/workspace-view-security.js";
import { decodeSecretViewCandidate } from "./diagnostics/secret-view-protocol.js";
import { buildSecretViewFixture } from "./diagnostics/secret-view-build.js";
import { isWindows, makeTempDirs } from "../../helpers.js";

describe.runIf(isWindows)("AD-55 signed Windows data/control candidate", () => {
  it("requires real live projected writes AND raw control isolation with the same effective actors", async () => {
    const dirs = await makeTempDirs();
    let built: Awaited<ReturnType<typeof buildSecretViewFixture>> | undefined;
    let nativeError = "";
    let view: Awaited<ReturnType<typeof createOwnedWorkspaceView>> | undefined;
    try {
      built = await buildSecretViewFixture();
      const proof = JSON.parse((await readFile(built.proof, "utf8")).replace(/^\uFEFF/, ""));
      expect(proof).toMatchObject({
        version: "2.3.1.1000",
        kernelPolicyVerified: true,
        dynamicImportVerified: true,
        signatureStatus: "Valid",
      });
      expect(proof.signer).toContain("Microsoft Windows Hardware Compatibility Publisher");
      const platform = await createNodePlatform();
      const privateRoot = path.join(dirs.outside, "private-view");
      await mkdir(privateRoot);
      await writeFile(path.join(dirs.workspace, "public.txt"), "CROT-AD55-BEFORE");
      const ffi = createRequire(import.meta.url)("koffi");
      const originals = [dirs.workspace, path.join(dirs.workspace, "public.txt")];
      const descriptors = originals.map((file) => snapshotWorkspaceDescriptor(ffi, file));
      const n = randomBytes(16);
      const ownerSid = await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows"));
      view = await createOwnedWorkspaceView({
        helper: built.helper,
        helperLauncher: {
          ...platform.launcher,
          launch: async (...args) => {
            const child = await platform.launcher.launch(...args);
            child.stderr.on("data", (chunk: Buffer) => {
              nativeError = (nativeError + chunk.toString("ascii")).slice(0, 4096);
            });
            return child;
          },
        },
        jobs: await loadViewJobObjectApi(),
        root: dirs.workspace,
        privateRoot,
        ownerSid,
        restrictingSid: `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`,
        protectedRelativeRoots: [],
        environment: platform.baseEnvironment,
      });
      // No copy-back occurs at teardown: original content must change while mounted.
      expect(await readFile(path.join(dirs.workspace, "public.txt"), "utf8")).toBe("CROT-AD55-AFTER");
      expect(originals.map((file) => snapshotWorkspaceDescriptor(ffi, file))).toEqual(descriptors);
      await view.close();
      view = undefined;
      expect(originals.map((file) => snapshotWorkspaceDescriptor(ffi, file))).toEqual(descriptors);
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-AD55-data-control",
          value: {
            proof,
            originalChangedBeforeUnmount: true,
            originalSecurityUnchanged: true,
            appContainerAndLpacRawIsolated: true,
            checkout: process.env.GITHUB_SHA,
          },
        }) + "\n",
      );
    } catch (cause) {
      const packet = /:([0-9a-f]{8})(?::[0-9a-f]{8})?\r?\n$/.exec(nativeError)?.[1];
      throw new Error(
        "AD-55 native candidate failed: " +
          JSON.stringify({
            nativeError,
            packet: packet ? decodeSecretViewCandidate(packet) : undefined,
            cause: String(cause),
          }),
      );
    } finally {
      try {
        await view?.close();
      } finally {
        await built?.cleanup();
        await dirs.cleanup();
      }
    }
  }, 300000);
});
