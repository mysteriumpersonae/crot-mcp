/** Rendering fixtures prove classification/presentation, not live vendor access. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { TRAY_ASSETS } from "../dist/tray/assets.js";
export async function runChatGroupScenarios({ evaluate, until, size, screenshot, navigate, call, artifacts, assert }) {
  await size(1584, 960);
  await navigate("/control-center");
  await until("document.getElementById('auth-gate')&&!document.getElementById('auth-gate').hidden");
  await evaluate(
    "document.getElementById('login').click();document.getElementById('auth-username').value='fixture_user';document.getElementById('auth-password').value='fixture-password-123';document.getElementById('auth-form').requestSubmit()",
  );
  await until("!document.getElementById('plan-gate').hidden");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose Free').click()");
  await until("!document.getElementById('app').hidden");
  await evaluate(`(()=>{
    const original=window.crot.product;
    window.chatGroupCalls=[];
    window.groupAccounts=[{provider:'youtube',id:'youtube-fixture',generation:'g1',state:'connected',handle:'video-fixture'},{provider:'notion',id:'notion-fixture',generation:'g2',state:'connected',handle:'workspace-fixture'}];
    window.groupConnectors=['FFmpeg Media Pipeline','Remotion','ElevenLabs','Slack','OpenAI'].map(id=>({id,enabled:true,status:'Connected'}));
    window.groupAgents=[{id:'local:opencode',name:'OpenCode',kind:'local',connected:true,revoked:false},{id:'remote:notion',name:'Notion agent',kind:'remote',connected:true,revoked:false},{id:'remote:entrim',name:'Entrim',kind:'remote',connected:true,revoked:false},{id:'local:offline',name:'Offline client',kind:'local',connected:false,revoked:false},{id:'remote:revoked',name:'Revoked client',kind:'remote',connected:true,revoked:true}];
    window.crot.product=async(name,input={})=>{window.chatGroupCalls.push([name,input]);
      if(name==='accounts.list')return {ok:true,accounts:groupAccounts};
      if(name==='connectors.list')return {ok:true,connectors:groupConnectors};
      if(name==='skills.list')return {ok:true,skills:[{id:'custom-edit',name:'Video editing skill'},{id:'custom-named-platform',name:'Notion export skill'}]};
      if(name==='mcpServers.list')return {ok:true,servers:[{id:'notion-mcp',name:'Notion Workspace MCP',status:'Connected'},{id:'speech-mcp',name:'ElevenLabs MCP',status:'Connected'},{id:'generic-mcp',name:'Verified tool provider',status:'Connected'}]};
      if(name==='agents.list')return {ok:true,agents:groupAgents,calls:[]};
      if(name==='chat.providers')return {ok:true,providers:[{provider:'Local HTTP',configured:true}]};
      if(name==='chat.models')return {ok:true,models:['fixture-model']};
      if(name==='chat.start'){window.groupMessage=input.message;return {ok:true,id:'group-message'};}
      if(name==='chat.poll')return {ok:true,blocks:[{type:'user',text:window.groupMessage},{type:'assistant',text:'Fixture response'}],state:'completed'};
      return original(name,input);
    };
    document.getElementById('nav-chat').click();
  })()`);
  await until("document.querySelector('.chat-agent-pill[aria-pressed=true]')");
  const open = async (group) => {
    await evaluate(`document.querySelector('.chat-dropdown.${group} .chat-selector').click()`);
    await until(`document.querySelector('.chat-dropdown.${group} .chat-popover:popover-open')`);
  };
  const close = () => evaluate("document.querySelector('.chat-popover:popover-open')?.hidePopover()");
  await open("skills");
  assert(
    await evaluate(
      "(()=>{const p=document.querySelector('#chat-menu-skills');return p.textContent.includes('FFmpeg')&&p.textContent.includes('Remotion')&&p.textContent.includes('ElevenLabs')&&p.textContent.includes('Add skill')&&!p.textContent.includes('Add connection')&&!p.querySelector('[data-connection-id=\"mcp:notion-mcp\"]')&&[...p.querySelectorAll('img')].every(i=>![PRODUCT.brands.notion,PRODUCT.brands.youtube].includes(i.getAttribute('src')));})()",
    ),
    "Skills contain remote platforms or unrelated footer logos",
  );
  await screenshot("chat-groups-skills");
  await evaluate("document.querySelector('#chat-menu-skills [data-connection-id=\"connector:ElevenLabs\"]').click()");
  await open("web");
  assert(
    await evaluate(
      "(()=>{const p=document.querySelector('#chat-menu-web');return p.textContent.includes('Connected Platforms')&&p.textContent.includes('YouTube')&&p.textContent.includes('Notion')&&p.textContent.includes('Slack')&&!p.textContent.includes('FFmpeg')&&!p.textContent.includes('ElevenLabs')&&!p.textContent.includes('OpenAI');})()",
    ),
    "Platforms include skills or agent-provider APIs",
  );
  await screenshot("chat-groups-platforms");
  await evaluate("document.querySelector('#chat-menu-web [data-connection-id=\"mcp:notion-mcp\"]').click()");
  assert(
    await evaluate(
      "(()=>{const p=document.querySelector('.chat-agent-pills');return p.textContent.includes('Local HTTP')&&['OpenCode','Notion agent','Entrim','OpenAI'].every(n=>!p.textContent.includes(n))&&!p.textContent.includes('Offline client')&&!p.textContent.includes('Revoked client')&&!p.textContent.includes('YouTube')&&!p.textContent.includes('FFmpeg');})()",
    ),
    "Inbound clients or connector credentials masquerade as callable chat models",
  );
  assert(
    await evaluate(
      "!document.querySelector('.chat-agents [data-agent-id]')&&!chatGroupCalls.some(c=>c[0]==='chat.start')",
    ),
    "An inbound MCP client appeared as an outbound provider",
  );
  await evaluate("window.CrotI18n.setLanguage('ru')");
  await until(
    "document.querySelector('.chat-compose textarea')&&document.querySelector('.chat-agent-pill[aria-pressed=true]')",
  );
  await evaluate("document.querySelector('.chat-compose textarea').focus()");
  const bounds = await evaluate(
    "(()=>{const send=document.querySelector('.chat-send'),badge=document.querySelector('#notification-count'),textarea=document.querySelector('.chat-compose textarea'),compose=document.querySelector('.chat-compose');const a=send.getBoundingClientRect(),b=badge.getBoundingClientRect(),s=getComputedStyle(textarea),bs=getComputedStyle(badge);return {send:[a.width,a.height],badge:[b.width,b.height],badgeDisplay:bs.display,badgeAlignment:bs.placeItems,outline:s.outlineStyle,shadow:s.boxShadow,border:s.borderTopWidth,outerBorder:getComputedStyle(compose).borderTopColor};})()",
  );
  assert(bounds.send[0] === 44 && bounds.send[1] === 44, "Send button is not a true circle");
  assert(
    bounds.badge[0] === 20 &&
      bounds.badge[1] === 20 &&
      bounds.badgeDisplay === "grid" &&
      bounds.badgeAlignment === "center",
    "Notification count is not centered in a circle",
  );
  assert(
    bounds.outline === "none" &&
      bounds.shadow === "none" &&
      bounds.border === "0px" &&
      bounds.outerBorder === "rgb(174, 182, 194)",
    "Composer still has an internal blue focus ring",
  );
  const r = await evaluate(
    "(()=>{const r=document.querySelector('.chat-compose').getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()",
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...r });
  await screenshot("chat-groups-focused-ru");
  await writeFile(
    path.join(artifacts, "chat-groups-preview.html"),
    (await evaluate("document.documentElement.outerHTML")).replace(
      /<head>[\s\S]*?<\/head>/,
      '<head><meta charset="utf-8"><style>' + TRAY_ASSETS["/app.css"].body + "</style></head>",
    ),
  );
  await size(390, 844);
  assert(
    await evaluate(
      "(()=>{const w=document.querySelector('.chat-welcome').getBoundingClientRect();const children=[...document.querySelector('.chat-welcome').children];return children.every(c=>{const r=c.getBoundingClientRect();return r.top>=w.top&&r.bottom<=w.bottom;})&&document.documentElement.scrollWidth<=innerWidth;})()",
    ),
    "Mobile welcome is clipped or overflows horizontally",
  );
  await screenshot("chat-groups-mobile-ru");
  await size(1584, 960);
  await evaluate("window.CrotI18n.setLanguage('en')");
  await until("document.querySelector('.chat-compose textarea')");
  await evaluate(
    "(()=>{const m=document.querySelector('.chat-compose textarea');m.value='Group context fixture';m.dispatchEvent(new Event('input'));document.querySelector('.chat-send').click();})()",
  );
  await until("chatGroupCalls.some(c=>c[0]==='chat.start')");
  assert(
    await evaluate(
      "(()=>{const r=chatGroupCalls.find(c=>c[0]==='chat.start')[1];return r.message.includes('mcp:notion-mcp')&&r.message.includes('connector:ElevenLabs')&&r.tools.length===0;})()",
    ),
    "Selected platform/skill context was lost or tools silently enabled",
  );
  await open("skills");
  await evaluate("document.querySelector('#chat-menu-skills .chat-add').click()");
  await until("document.querySelector('#action-dialog[open]')?.textContent.includes('Skill name')");
  await evaluate("document.querySelector('#action-dialog').close()");
  await writeFile(
    path.join(artifacts, "chat-groups-verification.json"),
    JSON.stringify(
      {
        status: "passed",
        scope: "Shipped Chromium assets with explicit connection/agent presentation fixtures; not live vendor access",
        bounds,
      },
      null,
      2,
    ),
  );
  await close();
}
