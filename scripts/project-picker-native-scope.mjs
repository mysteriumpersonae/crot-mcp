/** Exact native panel identity; AXSheet may expose its label as lowercase AXDescription. */
export function isProjectChooser(role, title, description) {
  return (
    ["AXWindow", "AXSheet", "AXDialog"].includes(role) &&
    (title || description).trim().toLowerCase() === "open project folder"
  );
}

export function isGoToFolder(role, title, description, childLabels = []) {
  if (!["AXWindow", "AXSheet", "AXDialog"].includes(role)) return false;
  const exact = (text) => ["go to folder", "go to the folder"].includes(text.trim().toLowerCase().replace(/:$/, ""));
  const identity = title || description;
  // A blank native sheet may name itself only through its own static label.
  // A conflicting nonempty title must never be overridden by descendant text.
  return identity ? exact(identity) : childLabels.some(exact);
}
