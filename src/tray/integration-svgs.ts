/** SVG icon strings for the Official Integrations card. No backticks — embedded in template literal. */

/** Notion: black rounded-corner document with ruled lines */
export const NOTION_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' aria-hidden='true'>" +
  "<rect width='100' height='100' rx='16' fill='#000'/>" +
  "<rect x='26' y='20' width='48' height='60' rx='6' fill='#fff'/>" +
  "<path d='M26 20v14a6 6 0 006 6h-6' fill='none' stroke='#fff' stroke-width='1.5'/>" +
  "<rect x='33' y='44' width='34' height='4' rx='2' fill='#ccc'/>" +
  "<rect x='33' y='54' width='34' height='4' rx='2' fill='#ccc'/>" +
  "<rect x='33' y='64' width='22' height='4' rx='2' fill='#ccc'/>" +
  "</svg>";

/**
 * Claude: Anthropic terracotta/orange background with an 8-ray starburst spark
 * (the official Anthropic/Claude brand mark — radiating lines forming a spark/asterisk).
 */
export const CLAUDE_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' aria-hidden='true'>" +
  "<rect width='100' height='100' rx='20' fill='#D97756'/>" +
  // 8-ray spark centered at 50,50
  "<g stroke='#fff' stroke-width='6.5' stroke-linecap='round' transform='translate(50,50)'>" +
  "<line x1='0' y1='-26' x2='0' y2='26'/>" +
  "<line x1='26' y1='0' x2='-26' y2='0'/>" +
  "<line x1='18.4' y1='-18.4' x2='-18.4' y2='18.4'/>" +
  "<line x1='18.4' y1='18.4' x2='-18.4' y2='-18.4'/>" +
  "</g>" +
  "</svg>";

/** n8n: pink/magenta background with three connected workflow node circles */
export const N8N_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' aria-hidden='true'>" +
  "<rect width='100' height='100' rx='20' fill='#EA4B71'/>" +
  "<circle cx='22' cy='55' r='13' fill='#fff'/>" +
  "<circle cx='78' cy='55' r='13' fill='#fff'/>" +
  "<circle cx='50' cy='28' r='11' fill='#fff'/>" +
  "<rect x='31' y='50' width='38' height='9' rx='4.5' fill='#fff'/>" +
  "<rect x='45' y='28' width='10' height='30' rx='5' fill='#fff'/>" +
  "</svg>";

/** Structured SVG node: [tag, attributes, children]. Built into DOM with createElementNS, never as markup. */
export type SvgTree = readonly [string, Readonly<Record<string, string>>, readonly SvgTree[]];
const SVG_TAGS = new Set(["svg", "g", "rect", "path", "circle", "line", "ellipse", "polygon", "polyline"]);
const SVG_ATTR =
  /^(?:xmlns|viewBox|aria-hidden|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|d|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|transform|opacity|points)$/;

/** Parse one of the static, first-party SVG strings above into a tree; throws on anything unexpected. */
export function svgTree(markup: string): SvgTree {
  const root: [string, Record<string, string>, SvgTree[]] = ["#root", {}, []];
  const stack: [string, Record<string, string>, SvgTree[]][] = [root];
  const token = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*='[^']*')*)\s*(\/?)>/gy;
  let index = 0;
  while (index < markup.length) {
    token.lastIndex = index;
    const m = token.exec(markup);
    if (!m) throw new Error("Unsupported SVG markup");
    index = token.lastIndex;
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (!SVG_TAGS.has(tag!)) throw new Error("Unsupported SVG element " + tag);
    if (closing) {
      const open = stack.pop();
      if (!open || open[0] !== tag) throw new Error("Unbalanced SVG markup");
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([a-zA-Z:-]+)='([^']*)'/g)) {
      if (!SVG_ATTR.test(a[1]!)) throw new Error("Unsupported SVG attribute " + a[1]);
      attrs[a[1]!] = a[2]!;
    }
    const node: [string, Record<string, string>, SvgTree[]] = [tag!, attrs, []];
    stack.at(-1)![2].push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root[2].length !== 1) throw new Error("Unbalanced SVG markup");
  return root[2][0]!;
}

export const INTEGRATION_SVG_TREES: Readonly<Record<string, SvgTree>> = {
  Notion: svgTree(NOTION_SVG),
  Claude: svgTree(CLAUDE_SVG),
  n8n: svgTree(N8N_SVG),
};
