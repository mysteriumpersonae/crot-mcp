/** External native AX driver for this test's real macOS chooser; never edits TCC. */
import process from "node:process";
import { Buffer } from "node:buffer";
import koffi from "koffi";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isProjectChooser, isGoToFolder } from "./project-picker-native-scope.mjs";
const pid = Number(process.argv[2]);
const selected = process.argv[3];
const report = { status: "failed", nodes: [] };
try {
  if (
    process.platform !== "darwin" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof selected !== "string" ||
    !path.isAbsolute(selected) ||
    selected.includes("\0") ||
    selected.length > 4096
  )
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
    const scan = () => {
      seen.clear();
      buttons.length = 0;
      report.nodes = [];
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
        const scope = inside || isProjectChooser(role, title, description);
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
      return buttons;
    };
    const postKey = ax.func("int AXUIElementPostKeyboardEvent(void *, unsigned short, unsigned short, bool)");
    const keyboard = (code, down, character = 0) => {
      const result = postKey(app, character, code, down);
      if (result !== 0) throw Error("Native AX keyboard event refused: " + result);
    };
    const focusedGoField = () => {
      const field = value(app, "AXFocusedUIElement");
      if (!field) return null;
      owned.push(field);
      const role = label(field, "AXRole");
      if (!["AXTextField", "AXComboBox"].includes(role)) return null;
      let parent = field;
      const ancestry = [];
      for (let depth = 0; depth < 16; depth++) {
        const role = label(parent, "AXRole"),
          title = label(parent, "AXTitle"),
          description = label(parent, "AXDescription");
        ancestry.push({ role, title, description });
        if (isGoToFolder(role, title, description)) {
          report.goFieldAncestry = ancestry;
          return field;
        }
        const next = value(parent, "AXParent");
        if (!next) break;
        owned.push(next);
        parent = next;
      }
      report.focusedAncestry = ancestry;
      return null;
    };
    report.phase = "open native Go to Folder";
    scan();
    if (buttons.length !== 1) throw Error("Expected one enabled Open button in the exact chooser before navigation");
    const stroke = (events) => {
      const held = [],
        errors = [];
      try {
        for (const [code, character = 0] of events) {
          keyboard(code, true, character);
          held.push([code, character]);
        }
      } catch (error) {
        errors.push(error);
      } finally {
        // A refused release must not leave the remaining modifiers held down.
        for (const [code, character] of held.reverse()) {
          try {
            keyboard(code, false, character);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Native AX keyboard stroke failed: " + errors.map(String).join("; "));
    };
    stroke([[55], [56], [5, 71]]);
    let field;
    const goDeadline = Date.now() + 3500;
    while (Date.now() < goDeadline && !(field = focusedGoField())) await delay(100);
    if (!field) throw Error("Native Go to Folder input unavailable inside its exact dialog");
    report.phase = "enter exact folder in native Go to Folder";
    const setValue = ax.func("int AXUIElementSetAttributeValue(void *, void *, void *)");
    const result = setValue(field, key("AXValue"), key(selected));
    if (result !== 0 || label(field, "AXValue") !== selected)
      throw Error("Native Go to Folder edit refused the exact fixture path: " + result);
    stroke([[36, 13]]);
    report.phase = "confirm native folder selection";
    const openDeadline = Date.now() + 3500;
    let ready = false;
    while (Date.now() < openDeadline) {
      await delay(100);
      if (!focusedGoField() && scan().length === 1) {
        ready = true;
        break;
      }
    }
    if (!ready) throw Error("Native Go to Folder did not finish navigation before Open");
    const pressed = press(buttons[0], key("AXPress"));
    if (pressed !== 0) throw Error("Native AXPress refused: " + pressed);
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
