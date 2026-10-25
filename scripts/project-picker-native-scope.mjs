/** Exact native panel identity; AXSheet may expose its label as lowercase AXDescription. */
export function isProjectChooser(role, title, description) {
  return (
    ["AXWindow", "AXSheet", "AXDialog"].includes(role) &&
    (title || description).trim().toLowerCase() === "open project folder"
  );
}

export function isGoToFolder(role, title, description) {
  return (
    ["AXWindow", "AXSheet", "AXDialog"].includes(role) &&
    ["go to folder", "go to the folder"].includes((title || description).trim().toLowerCase().replace(/:$/, ""))
  );
}
