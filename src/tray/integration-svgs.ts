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
