/** External native AX driver for this test's real macOS chooser; never edits TCC. */
import process from "node:process";
import { Buffer } from "node:buffer";
import koffi from "koffi";
const pid = Number(process.argv[2]);
const report = { status: "failed", nodes: [] };
try {
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Expected a live test Electron PID on macOS");
  const ax = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
  if (!ax.func("bool AXIsProcessTrusted(void)")())
    throw Error(
      "Native AX permission unavailable: an authorized UI-test desktop is required; TCC is not changed or bypassed",
    );
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const retain = cf.func("void *CFRetain(void *)"),
    release = cf.func("void CFRelease(void *)");
  const string = cf.func("void *CFStringCreateWithCString(void *, const char *, unsigned int)");
  const stringType = cf.func("unsigned long CFStringGetTypeID(void)"),
    type = cf.func("unsigned long CFGetTypeID(void *)");
  const text = cf.func("bool CFStringGetCString(void *, _Out_ char *, long, unsigned int)");
  const arrayType = cf.func("unsigned long CFArrayGetTypeID(void)"),
    length = cf.func("long CFArrayGetCount(void *)"),
    item = cf.func("void *CFArrayGetValueAtIndex(void *, long)");
  const booleanType = cf.func("unsigned long CFBooleanGetTypeID(void)"),
    boolean = cf.func("bool CFBooleanGetValue(void *)");
  const copy = ax.func("int AXUIElementCopyAttributeValue(void *, void *, _Out_ void **)");
  const press = ax.func("int AXUIElementPerformAction(void *, void *)");
  const app = ax.func("void *AXUIElementCreateApplication(int)")(pid);
  if (!app) throw Error("Native AX application unavailable");
  const owned = [app],
    keys = new Map(),
    seen = new Set(),
    buttons = [];
  const key = (name) => {
    if (!keys.has(name)) {
      const value = string(null, name, 0x08000100);
      if (!value) throw Error("Native AX attribute allocation failed");
      keys.set(name, value);
    }
    return keys.get(name);
  };
  const value = (node, name) => {
    const out = [null];
    const error = copy(node, key(name), out);
    if (error !== 0) {
      if (out[0]) release(out[0]);
      return null;
    }
    return out[0];
  };
  const label = (node, name) => {
    const result = value(node, name);
    if (!result) return "";
    try {
      if (type(result) !== stringType()) return "";
      const data = Buffer.alloc(1024);
      return text(result, data, data.length, 0x08000100) ? data.subarray(0, data.indexOf(0)).toString("utf8") : "";
    } finally {
      release(result);
    }
  };
  const enabled = (node) => {
    const result = value(node, "AXEnabled");
    if (!result) return false;
    try {
      return type(result) === booleanType() && boolean(result);
    } finally {
      release(result);
    }
  };
  const children = (node, name) => {
    const result = value(node, name);
    if (!result) return [];
    try {
      if (type(result) !== arrayType()) return [];
      const count = Number(length(result));
      if (count < 0 || count > 512) throw Error("Native AX children bound exceeded");
      const values = [];
      for (let i = 0; i < count; i++) {
        const child = retain(item(result, i));
        owned.push(child);
        values.push(child);
      }
      return values;
    } finally {
      release(result);
    }
  };
  try {
    if (ax.func("int AXUIElementSetMessagingTimeout(void *, float)")(app, 1) !== 0)
      throw Error("Native AX messaging bound unavailable");
    const queue = children(app, "AXWindows").map((node) => ({ node, inside: false }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (queue.length > 512) throw Error("Native AX traversal bound exceeded");
      const { node, inside } = queue[cursor],
        identity = String(node);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const role = label(node, "AXRole"),
        title = label(node, "AXTitle"),
        description = label(node, "AXDescription");
      const scope = inside || (["AXWindow", "AXSheet", "AXDialog"].includes(role) && title === "Open project folder");
      if (report.nodes.length < 48)
        report.nodes.push({ role, title: title.slice(0, 100), description: description.slice(0, 100), scope });
      if (
        scope &&
        role === "AXButton" &&
        ["Open", "Choose", "Select Folder"].includes(title || description) &&
        enabled(node)
      )
        buttons.push(node);
      for (const name of ["AXChildren", "AXSheets"])
        for (const child of children(node, name)) queue.push({ node: child, inside: scope });
    }
    if (buttons.length !== 1)
      throw Error("Expected one enabled confirmation button inside the exact native chooser; found " + buttons.length);
    const result = press(buttons[0], key("AXPress"));
    if (result !== 0) throw Error("Native AXPress refused: " + result);
    report.status = "pressed";
    report.pid = pid;
  } finally {
    for (const ref of owned.reverse()) release(ref);
    for (const ref of keys.values()) release(ref);
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
}
process.stdout.write(JSON.stringify(report) + "\n");
