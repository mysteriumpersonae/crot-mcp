/** Exact native panel identity; AXSheet may expose its label as lowercase AXDescription. */
export function isProjectChooser(role, title, description) {
  return (
    ["AXWindow", "AXSheet", "AXDialog"].includes(role) &&
    (title || description).trim().toLowerCase() === "open project folder"
  );
}
