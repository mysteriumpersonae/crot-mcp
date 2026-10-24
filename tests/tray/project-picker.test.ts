import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectFolderPicker } from "../../src/tray/project-picker.js";

const selectedPath = path.resolve("test-native-project");
const choice = () => Promise.resolve({ canceled: false, filePaths: [selectedPath] });
const success = { ok: true, project: { id: "registered-id" } };
describe("native owner project folder workflow", () => {
  it("registers only the native selection and selects the service-issued id", async () => {
    const product = vi.fn().mockResolvedValue(success);
    expect(await new ProjectFolderPicker().open({ choose: choice, product })).toBe(true);
    expect(product.mock.calls).toEqual([
      ["projects.open", { path: selectedPath }],
      ["projects.select", { id: "registered-id" }],
    ]);
  });
  it.each([
    { canceled: true, filePaths: [selectedPath] },
    { canceled: false, filePaths: [] },
    { canceled: false, filePaths: [selectedPath, selectedPath] },
    { canceled: false, filePaths: ["relative"] },
    { canceled: false, filePaths: [selectedPath + "\0"] },
  ])("does not mutate projects on cancellation or invalid choice: %j", async (value) => {
    const product = vi.fn();
    expect(await new ProjectFolderPicker().open({ choose: async () => value, product })).toBe(false);
    expect(product).not.toHaveBeenCalled();
  });
  it.each([undefined, { ok: false, project: { id: "id" } }, { ok: true, project: {} }])(
    "never selects after an invalid registration: %j",
    async (opened) => {
      const product = vi.fn().mockResolvedValue(opened);
      expect(await new ProjectFolderPicker().open({ choose: choice, product })).toBe(false);
      expect(product).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, { ok: false, project: { id: "registered-id" } }, { ok: true, project: { id: "other" } }])(
    "does not report success when workspace switching fails: %j",
    async (selected) => {
      const product = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(selected);
      expect(await new ProjectFolderPicker().open({ choose: choice, product })).toBe(false);
    },
  );
  it("prevents overlapping native dialogs and resets after cancellation", async () => {
    const picker = new ProjectFolderPicker();
    let finish!: (result: { canceled: boolean; filePaths: string[] }) => void;
    const choose = vi.fn(() => new Promise<{ canceled: boolean; filePaths: string[] }>((r) => (finish = r)));
    const product = vi.fn();
    const first = picker.open({ choose, product });
    expect(await picker.open({ choose, product })).toBe(false);
    expect(choose).toHaveBeenCalledTimes(1);
    finish({ canceled: true, filePaths: [] });
    expect(await first).toBe(false);
    expect(await picker.open({ choose: choice, product: vi.fn().mockResolvedValue(success) })).toBe(true);
  });
  it("does not acknowledge an intermediate workspace publication before selection persistence/audit finishes", async () => {
    const picker = new ProjectFolderPicker();
    let finish!: (result: typeof success) => void;
    const selected = new Promise<typeof success>((resolve) => (finish = resolve));
    const product = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockImplementationOnce(() => selected);
    let acknowledged = false;
    const first = picker.open({ choose: choice, product }).then((result) => {
      acknowledged = true;
      return result;
    });
    await vi.waitFor(() => expect(product).toHaveBeenCalledTimes(2));
    expect(acknowledged).toBe(false);
    const competingChoice = vi.fn(choice);
    expect(await picker.open({ choose: competingChoice, product })).toBe(false);
    expect(competingChoice).not.toHaveBeenCalled();
    finish(success);
    expect(await first).toBe(true);
    expect(acknowledged).toBe(true);
  });
  it("does not acknowledge success when post-switch persistence or audit later fails", async () => {
    const picker = new ProjectFolderPicker();
    let refuse!: (error: Error) => void;
    const selected = new Promise<never>((_resolve, reject) => (refuse = reject));
    const product = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockImplementationOnce(() => selected);
    const result = expect(picker.open({ choose: choice, product })).rejects.toThrow("selection audit refused");
    await vi.waitFor(() => expect(product).toHaveBeenCalledTimes(2));
    refuse(new Error("selection audit refused"));
    await result;
    expect(await picker.open({ choose: choice, product: vi.fn().mockResolvedValue(success) })).toBe(true);
  });
  it("propagates real service errors and releases the dialog lock", async () => {
    const picker = new ProjectFolderPicker();
    const product = vi.fn().mockRejectedValue(new Error("workspace is busy"));
    await expect(picker.open({ choose: choice, product })).rejects.toThrow("workspace is busy");
    expect(await picker.open({ choose: choice, product: vi.fn().mockResolvedValue(success) })).toBe(true);
  });
});
