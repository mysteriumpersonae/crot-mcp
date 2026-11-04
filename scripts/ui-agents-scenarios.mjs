import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
/** Real CrotService actions with local HTTP provider fixtures; no live vendor claims. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRAY_ASSETS } from "../dist/tray/assets.js";
export async function runAgentsScenarios({
  real,
  evaluate,
  until,
  size,
  screenshot: capture,
  navigate,
  call,
  artifacts,
  assert,
}) {
  const screenshot = async (name) => {
    await evaluate("new Promise(r=>setTimeout(r,320))");
    return capture(name);
  };
  await size(1584, 1040);
  await navigate("/control-center");
  await until("document.getElementById('auth-gate')&&!document.getElementById('auth-gate').hidden");
  await evaluate(
    "document.getElementById('login').click();document.getElementById('auth-username').value='fixture_user';document.getElementById('auth-password').value='fixture-password-123';document.getElementById('auth-form').requestSubmit()",
  );
  await until("!document.getElementById('plan-gate').hidden");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose Free').click()");
  await until("!document.getElementById('app').hidden");
  await evaluate("document.getElementById('nav-agents').click()");
  await until("document.querySelector('[data-agents-center]')&&!document.querySelector('[data-provider-loading]')");
  assert(
    await evaluate(
      "!document.querySelector('#page .context-tools')&&getComputedStyle(document.querySelector('.agents-center')).gap==='24px'",
    ),
    "Agents still has extra workspace tabs",
  );
  // Unpaired: either no URL, or only the canonical key-derived self-registration URL (#59), never an invented host.
  assert(
    await evaluate(
      "(v=>!v||/^https:\\/\\/crot\\.network\\/d\\/[a-z2-7]{26}\\/mcp$/.test(v))(document.querySelector('[data-relay-url]').value)",
    ),
    "Unpaired device invented a relay URL",
  );
  const sidebar = await evaluate("document.querySelector('.sidebar').getBoundingClientRect().width");
  await call("Browser.grantPermissions", {
    origin: new URL(await evaluate("location.href")).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await evaluate(
    "(()=>{const d=document.querySelector('.agents-local-access');if(d)d.open=true;document.querySelector('[data-generate-token]').click();})()",
  );
  await until("document.getElementById('action-dialog').open");
  await evaluate("[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Cancel').click()");
  assert(
    await evaluate("(async()=>!(await window.crot.product('tokens.list')).tokens.length)()"),
    "Cancelled token generation mutated service",
  );
  const generate = async () => {
    await until("!document.querySelector('[data-generate-token]').disabled");
    await evaluate("document.querySelector('[data-generate-token]').click()");
    await until("document.getElementById('action-dialog').open");
    await evaluate(
      "[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Confirm').click()",
    );
    await until("document.querySelector('[data-bearer-token]').value.length>20");
  };
  await generate();
  const before = await evaluate("document.querySelector('[data-bearer-token]').value");
  await evaluate("document.querySelector('[aria-label=\"Copy token\"]').click()");
  await until("document.querySelector('.agents-copy-status').textContent==='Copied to clipboard'");
  assert((await evaluate("navigator.clipboard.readText()")) === before, "Token clipboard copy failed");
  await evaluate("document.querySelector('[aria-label=\"Show token\"]').click()");
  assert(await evaluate("document.querySelector('[data-bearer-token]').type==='text'"), "Eye did not reveal token");
  await evaluate("document.querySelector('[aria-label=\"Hide token\"]').click()");
  await evaluate("document.querySelector('[data-generate-token]').click()");
  await until("document.getElementById('action-dialog').open");
  await evaluate("[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Confirm').click()");
  await until(`document.querySelector('[data-bearer-token]').value!==${JSON.stringify(before)}`);
  const after = await evaluate("document.querySelector('[data-bearer-token]').value"),
    tokens = JSON.parse(await readFile(path.join(real.stateDir, "client-tokens.json"), "utf8"));
  assert(tokens.tokens.length === 1 && tokens.tokens[0].active, "Rotation did not replace same registry token");
  // The audit journal is appended asynchronously after the RPC reply.
  let journal = "";
  for (let i = 0; i < 50 && !journal.includes("token_rotate"); i++) {
    journal = await readFile(path.join(real.base, "audit.jsonl"), "utf8");
    if (!journal.includes("token_rotate")) await delay(100);
  }
  assert(
    journal.includes("token_issue") &&
      journal.includes("token_rotate") &&
      !journal.includes(before) &&
      !journal.includes(after),
    "Token audit missing or contains secret",
  );
  assert(
    !JSON.stringify(tokens).includes(before) && !JSON.stringify(tokens).includes(after),
    "Token plaintext persisted",
  );
  // Other authorization methods of the crot.network URL (self-registered device): Basic, API key, OAuth.
  const relayUrl = await evaluate("document.querySelector('[data-relay-url]').value");
  const deviceId = /^https:\/\/crot\.network\/d\/([a-z2-7]{26})\/mcp$/.exec(relayUrl ?? "")?.[1];
  const authMethods = await evaluate(
    "(()=>{const d=document.querySelector('[data-auth-methods]');if(!d)return null;d.open=true;const v=k=>d.querySelector('[data-auth-value='+JSON.stringify(k)+']');return {summary:d.querySelector('summary').textContent,values:Object.fromEntries([...d.querySelectorAll('[data-auth-value]')].map(i=>[i.dataset.authValue,i.value])),readOnly:[...d.querySelectorAll('[data-auth-value]')].every(i=>i.readOnly),copies:d.querySelectorAll('button').length,secretPlaceholder:v('oauth-client-secret').placeholder};})()",
  );
  if (deviceId) {
    assert(
      authMethods?.summary === "Other authorization methods (Basic, API Key, OAuth)" &&
        authMethods.values["basic-username"] === "crot" &&
        authMethods.values["api-key-header"] === "X-API-Key" &&
        authMethods.values["oauth-client-id"] === `crot-${deviceId}` &&
        authMethods.values["basic-password"] === "" &&
        authMethods.values["oauth-client-secret"] === "" &&
        authMethods.secretPlaceholder === "Same as the Bearer token" &&
        authMethods.readOnly &&
        authMethods.copies === 6,
      "Authorization methods panel: " + JSON.stringify(authMethods),
    );
    await evaluate("document.querySelector('[data-auth-methods]').scrollIntoView({block:'center'})");
    await screenshot("agents-auth-methods");
    // A copy button of a token row copies the visible token.
    await evaluate(
      "document.querySelector('[data-auth-value=\"api-key-value\"]').parentElement.querySelector('button').click()",
    );
    await until("navigator.clipboard.readText().then(v=>v===document.querySelector('[data-bearer-token]').value)");
    await evaluate("document.querySelector('[data-auth-methods]').open=false");
  } else assert(authMethods === null, "Authorization methods shown without a self-registered URL");

  // OpenCode (Free & Zen): the optional key field, its hint and Save & Test stay visible; free models are listed.
  await evaluate("document.querySelectorAll('.agents-accordion')[0].open=true");
  const zen = await evaluate(
    `(async()=>{const select=document.querySelector('select[aria-label="Chat provider"]');select.value='OpenCode (Free & Zen)';select.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,300));const visible=el=>!!el&&el.getClientRects().length>0;const key=document.querySelector('[data-cloud-key]');return {label:document.querySelector('[data-cloud-key-field]').firstChild.textContent,placeholder:key.placeholder,key:visible(key),test:visible(document.querySelector('[data-cloud-test]')),hint:visible(document.querySelector('[data-zen-hint]')),models:[...document.querySelector('select[aria-label="Default cloud model"]').options].map(o=>o.value)};})()`,
  );
  assert(
    zen.label === "API Key (optional for Free / Zen API Key)" &&
      zen.placeholder === "Optional: OpenCode Zen API key" &&
      zen.key &&
      zen.test &&
      zen.hint &&
      zen.models.includes("big-pickle"),
    "OpenCode (Free & Zen) form: " + JSON.stringify(zen),
  );
  await screenshot("agents-opencode-zen-free");
  // Every cloud provider keeps its key field and Save & Test; Local and Workspaces keep their checks.
  const forms = await evaluate(
    `(async()=>{const select=document.querySelector('select[aria-label="Chat provider"]');const visible=el=>!!el&&el.getClientRects().length>0;const out={};for(const value of [...select.options].map(o=>o.value)){select.value=value;select.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,80));out[value]=visible(document.querySelector('[data-cloud-test]'))&&visible(document.querySelector('[data-cloud-key]'))&&(value==='OpenCode (Free & Zen)')===visible(document.querySelector('[data-zen-hint]'));}select.value='OpenAI';select.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,80));return out;})()`,
  );
  assert(
    Object.keys(forms).length === 6 && Object.values(forms).every(Boolean),
    "A cloud provider lost its key field or Save & Test: " + JSON.stringify(forms),
  );
  const local = await evaluate(
    "(()=>{document.querySelectorAll('.agents-accordion')[1].open=true;const l=[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='Server URL / Port');return {url:l.querySelector('input').value,presets:[...document.querySelectorAll('[data-local-preset]')].map(b=>b.dataset.localPreset),test:!!document.querySelector('[data-local-test]')};})()",
  );
  assert(
    local.url === "http://127.0.0.1:11434" && local.presets.join() === "Ollama,LM Studio" && local.test,
    "Local LLM form: " + JSON.stringify(local),
  );
  await evaluate("(()=>{document.querySelector('[data-local-preset=\"LM Studio\"]').click();})()");
  assert(
    (await evaluate(
      "[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='Server URL / Port').querySelector('input').value",
    )) === "http://127.0.0.1:1234",
    "LM Studio preset did not fill its URL",
  );
  await evaluate("document.querySelectorAll('.agents-accordion')[0].open=true");
  const state = await real.verify(),
    endpoint = state.endpoint.replace("/provider-probe", "/chat-provider/v1");
  await evaluate(
    `(()=>{const input=document.querySelector('input[type=url]');const fields=[...document.querySelectorAll('label')];fields.find(l=>l.querySelector('span')?.textContent==='API base URL').querySelector('input').value=${JSON.stringify(endpoint)};document.querySelector('[data-cloud-key]').value='fixture-ui-agents-key';document.querySelector('[data-cloud-test]').click();})()`,
  );
  await until("document.querySelector('.agents-accordion .agents-connection-state.connected')");
  const c = await evaluate(
    "(async()=>(await window.crot.product('chat.providers')).providers.find(p=>p.provider==='OpenAI'))()",
  );
  assert(
    c.connectionStatus === "connected" &&
      c.defaultModel === "ui-model" &&
      c.checkedAt &&
      !JSON.stringify(c).includes("fixture-ui-agents-key"),
    "Cloud Save & Test did not persist verified status/default safely",
  );
  await evaluate("document.querySelectorAll('.agents-accordion')[1].open=true");
  await evaluate(
    `(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='Server URL / Port');l.querySelector('input').value=${JSON.stringify(endpoint.replace("/v1", ""))};document.querySelector('[data-local-test]').click();})()`,
  );
  await until("document.querySelectorAll('.agents-connection-state.connected').length===2");
  // Native workspace agent transports, not accounts.list or workspace data connectors.
  for (const [provider, prefix, secret, answer] of [
    ["OpenCode", "/native-opencode", "fixture-opencode-password", "OpenCode native fixture answer"],
    ["Notion Agents", "/native-notion/v1", "fixture-notion-agents-key", "Notion native fixture answer"],
  ]) {
    await evaluate("document.getElementById('nav-agents').click()");
    await until("document.querySelector('[data-workspace-test]')&&!document.querySelector('[data-provider-loading]')");
    await size(1280, 800);
    await evaluate("document.querySelectorAll('.agents-accordion')[2].open=true");
    await until("document.querySelectorAll('.agents-accordion[open]').length===1");
    assert(
      await evaluate(
        "document.querySelector('.agents-column:last-child').scrollWidth<=document.querySelector('.agents-column:last-child').clientWidth",
      ),
      "Workspace accordion overflows horizontally",
    );
    await evaluate("document.querySelector('[aria-label=\"Workspace agent provider\"].agents-choice-trigger').click()");
    await until("document.querySelector('.chat-popover:popover-open')");
    await evaluate(
      `[...document.querySelectorAll('.chat-popover:popover-open button')].find(b=>b.textContent.replace('✓','').trim()===${JSON.stringify(provider)}).click()`,
    );
    const origin = new URL(state.endpoint).origin;
    await evaluate(
      `document.querySelector('[data-workspace-endpoint]').value=${JSON.stringify(origin)}+${JSON.stringify(prefix)};document.querySelector('[data-workspace-key]').value=${JSON.stringify(secret)};document.querySelector('[data-workspace-test]').click()`,
    );
    await until("document.getElementById('action-dialog').open");
    await evaluate(
      "[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Confirm').click()",
    );
    await until(
      "document.querySelectorAll('.agents-accordion')[2].querySelector('.agents-connection-state.connected')",
    );
    const saved = await evaluate(
      `(async()=>(await window.crot.product('chat.providers')).providers.find(p=>p.provider===${JSON.stringify(provider)}))()`,
    );
    assert(
      saved.connectionStatus === "connected" && saved.defaultModel && saved.kind === "workspace",
      "Native workspace agent was not saved/verified",
    );
    assert(
      await evaluate(
        "(()=>{const column=document.querySelector('.agents-column:last-child'),d=column.querySelector('.agents-accordion[open]');return d.getBoundingClientRect().bottom<=column.getBoundingClientRect().bottom+1})()",
      ),
      "Active workspace content is clipped at desktop height",
    );
    await screenshot("agents-workspace-" + provider.toLowerCase().replaceAll(" ", "-"));
    await evaluate("document.getElementById('nav-chat').click()");
    await until("document.querySelectorAll('.chat-agent-pill').length>=3");
    // Provider pills (#56/#57): first click activates the provider, a click on the active pill opens its model popover.
    const pill = `[...document.querySelectorAll('.chat-agent-pill')].find(b=>b.querySelector('span')?.textContent===${JSON.stringify(provider)})`;
    await until(pill);
    await evaluate(`(()=>{const b=${pill};if(b.getAttribute('aria-pressed')!=='true')b.click();})()`);
    await until(`${pill}?.getAttribute('aria-pressed')==='true'`);
    await evaluate(`${pill}.click()`);
    await until("document.querySelector('dialog.chat-model-pop[open]')");
    assert(
      await evaluate(
        `(()=>{const pop=document.querySelector('dialog.chat-model-pop[open]'),bar=document.querySelector('.chat-agents'),p=pop.getBoundingClientRect(),b=${pill}.getBoundingClientRect(),s=getComputedStyle(pop);return pop.parentElement===bar&&s.position==='absolute'&&Math.abs(parseFloat(s.bottom)-(bar.clientHeight+8))<1&&p.bottom<=b.top&&p.top>=0&&p.left>=0&&p.right<=innerWidth;})()`,
      ),
      "Model popover must open upward (bottom: calc(100% + 8px)) inside the window",
    );
    assert(
      await evaluate(
        `(()=>{const bar=getComputedStyle(document.querySelector('.chat-agent-pills')),b=${pill},s=getComputedStyle(b),i=b.querySelector('svg,img').getBoundingClientRect();return bar.justifyContent==='flex-start'&&b.offsetHeight>=28&&b.offsetHeight<=30&&s.fontSize==='12px'&&Math.round(i.width)===14;})()`,
      ),
      "Provider chips must be left-aligned, 28-30px high with 14px icons and 12px text",
    );
    await until(
      `[...document.querySelectorAll('dialog.chat-model-pop[open] .chat-menu-item')].some(b=>b.textContent.includes(${JSON.stringify(saved.defaultModel)}))`,
    );
    await evaluate(
      `[...document.querySelectorAll('dialog.chat-model-pop[open] .chat-menu-item')].find(b=>b.textContent.includes(${JSON.stringify(saved.defaultModel)})).click()`,
    );
    await evaluate(
      "(()=>{const m=document.querySelector('.chat-compose textarea');m.value='Native workspace transport test';m.dispatchEvent(new Event('input'));document.querySelector('.chat-send').click();})()",
    );
    await until(
      `[...document.querySelectorAll('.chat-message-text')].some(n=>n.textContent.includes(${JSON.stringify(answer)}))`,
    );
  }
  await evaluate("document.getElementById('nav-agents').click()");
  await until("!document.querySelector('[data-provider-loading]')");
  await evaluate("window.CrotI18n.setLanguage('ru')");
  await until(
    "document.querySelectorAll('.agents-connection-state.connected').length>=2&&!document.querySelector('[data-provider-loading]')",
  );
  assert(
    (await evaluate("document.querySelector('.sidebar').getBoundingClientRect().width")) === sidebar,
    "Sidebar geometry changed",
  );
  // Column headers (round icon + title) must never be clipped at the top, at any window size.
  for (const [w, h] of [
    [1584, 960],
    [1280, 720],
    [1024, 640],
    [900, 560],
    [390, 844],
  ]) {
    await size(w, h);
    assert(
      await evaluate(
        "(()=>{const heads=[...document.querySelectorAll('.agents-column-head')];return heads.length>=2&&heads.every(head=>{head.scrollIntoView({block:'nearest'});const r=head.getBoundingClientRect(),col=head.closest('.agents-column').getBoundingClientRect();if(r.height<16||r.top<col.top-0.5||r.top<-0.5)return false;let p=head.parentElement;while(p&&p!==document.body){const s=getComputedStyle(p);if(s.overflowY!=='visible'&&p.getBoundingClientRect().top>r.top+0.5)return false;p=p.parentElement;}const hit=document.elementFromPoint(r.left+Math.min(12,r.width/2),r.top+Math.min(8,r.height/2));return !!hit&&head.contains(hit);});})()",
      ),
      `Agents column headers are clipped at ${w}x${h}`,
    );
  }
  await size(1584, 960);
  await writeFile(
    path.join(artifacts, "layout.json"),
    JSON.stringify(
      await evaluate(
        "[...document.querySelectorAll('.agents-column,.agents-card')].map(n=>({className:n.className,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,height:n.getBoundingClientRect().height}))",
      ),
      null,
      2,
    ),
  );
  assert(
    await evaluate(
      "[...document.querySelectorAll('.agents-column')].every(n=>n.getBoundingClientRect().bottom<=innerHeight+1)",
    ),
    "Desktop cards do not fit the reference viewport",
  );
  await screenshot("agents-center-ru-real-service");
  await writeFile(
    path.join(artifacts, "agents-center-preview.html"),
    (
      await evaluate(
        "(()=>{const copy=document.documentElement.cloneNode(true),fields=document.querySelectorAll('input'),clones=copy.querySelectorAll('input');fields.forEach((input,i)=>{if(input.type!=='password')clones[i].setAttribute('value',input.value);});return copy.outerHTML;})()",
      )
    ).replace(
      /<head>[\s\S]*?<\/head>/,
      '<head><meta charset="utf-8"><style>' + TRAY_ASSETS["/app.css"].body + "</style></head>",
    ),
  );
  await size(1280, 800);
  await evaluate("document.querySelectorAll('.agents-accordion')[2].open=true");
  await until("document.querySelectorAll('.agents-accordion[open]').length===1");
  await screenshot("agents-workspace-ru-1280");
  await size(390, 844);
  await screenshot("agents-center-mobile-ru");
  await evaluate("const main=document.querySelector('main.content'); main.scrollTop=main.scrollHeight");
  await screenshot("agents-workspace-mobile-ru");
  // Opening Agents always starts at the top, however far the page was scrolled before.
  assert((await evaluate("document.querySelector('main.content').scrollTop")) > 0, "Mobile Agents did not scroll");
  await evaluate("document.getElementById('nav-home').click()");
  await evaluate("document.getElementById('nav-agents').click()");
  await until("document.querySelector('[data-agents-center]')&&!document.querySelector('[data-provider-loading]')");
  assert(await evaluate("document.querySelector('main.content').scrollTop===0"), "Agents did not open at the top");
  await size(1584, 960);
  await evaluate("window.CrotI18n.setLanguage('en')");
  assert(
    await evaluate(
      "!document.querySelector('[data-integration]')&&!document.querySelector('.agents-center').textContent.includes('Official integrations')",
    ),
    "Instructions masquerade as integrations",
  );
  // Switch every section repeatedly, sampling actual animation frames.
  for (const index of [1, 2, 0, 2, 1, 0]) {
    await evaluate(`document.querySelectorAll('.agents-accordion > summary')[${index}].click()`);
    const frames = await evaluate(
      `(async()=>{const frames=[];for(let i=0;i<18;i++){await new Promise(requestAnimationFrame);const column=document.querySelector('.agents-outbound');frames.push({open:column.querySelectorAll('.agents-accordion[open]').length,width:column.clientWidth,scroll:column.scrollWidth>column.clientWidth});}return frames;})()`,
    );
    assert(
      frames.every((f) => f.open === 1 && !f.scroll) && new Set(frames.map((f) => f.width)).size === 1,
      "Section switch flickered or overflowed",
    );
  }
  // Presentation-only paired URL: exercise recipes/copy without claiming a live paired relay.
  const recipeUrl = "https://mcp.crot.network/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/mcp";
  await evaluate(
    `(async()=>{const v=await window.crot.request('view');window.originalViewRender=window.crot.render;window.crot.render=next=>window.originalViewRender({...next,resourceUri:${JSON.stringify(recipeUrl)}});window.crot.render(v);document.getElementById('nav-agents').click();})()`,
  );
  await until("document.querySelector('[data-relay-url]').value.includes('mcp.crot.network')");
  await evaluate("document.querySelector('[aria-label=\"Copy URL\"]').click()");
  await until(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(recipeUrl)})()`);
  assert(
    await evaluate(
      "[...document.querySelectorAll('.agents-center .agents-description')].some(n=>n.textContent==='Paste the MCP server URL and the Bearer Token into Custom MCP settings (Notion, Claude, n8n).')&&!document.querySelector('.agents-center').textContent.includes('OAuth 2.1')",
    ),
    "Relay connection instructions missing",
  );
  await evaluate("document.getElementById('nav-chat').click()");
  await until(
    "[...document.querySelectorAll('.chat-agent-pill')].some(b=>b.querySelector('span')?.textContent==='OpenAI')",
  );
  await evaluate(
    "(()=>{const b=[...document.querySelectorAll('.chat-agent-pill')].find(b=>b.querySelector('span')?.textContent==='OpenAI');if(b.getAttribute('aria-pressed')!=='true')b.click();})()",
  );
  await evaluate(
    "(()=>{const m=document.querySelector('.chat-compose textarea');m.value='Real saved provider check';m.dispatchEvent(new Event('input'));document.querySelector('.chat-send').click();})()",
  );
  await until(
    "[...document.querySelectorAll('.chat-message-text')].some(n=>n.textContent.includes('Real provider fixture response'))",
  );
  await evaluate(
    "(async()=>{window.crot.render=window.originalViewRender;window.crot.render(await window.crot.request('view'));})()",
  );
  // Genuine provider failure must never keep a green state.
  await evaluate("document.getElementById('nav-agents').click()");
  await until("!document.querySelector('[data-provider-loading]')&&document.querySelector('[data-cloud-test]')");
  await evaluate(
    `(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='API base URL');l.querySelector('input').value=${JSON.stringify(state.endpoint)};document.querySelector('[data-cloud-test]').click();})()`,
  );
  await until("document.querySelector('.agents-accordion .agents-connection-state.failed')");
  assert(
    await evaluate(
      "(async()=>(await window.crot.product('chat.providers')).providers.find(p=>p.provider==='OpenAI').connectionStatus==='failed')()",
    ),
    "Failed test kept connected service status",
  );
  // Named provider (legacy River removed; OpenRouter), real local HTTP 401, safe diagnostic and selection persistence.
  await evaluate(
    `(()=>{const select=document.querySelector('select[aria-label="Chat provider"]');select.value='OpenRouter';select.dispatchEvent(new Event('change'));const l=[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='API base URL');l.querySelector('input').value=${JSON.stringify(endpoint.replace("/chat-provider/", "/chat-denied/"))};document.querySelector('[data-cloud-key]').value='fixture-river-secret';document.querySelector('[data-cloud-test]').click();})()`,
  );
  await until(
    "document.querySelector('.agents-accordion .agents-connection-state.failed')?.textContent.includes('HTTP 401')",
  );
  assert(
    await evaluate(
      "!document.querySelector('.agents-center').textContent.includes('provider-body-secret')&&!document.querySelector('.agents-center').textContent.includes('fixture-river-secret')",
    ),
    "Provider response or key exposed",
  );
  await evaluate(
    "(()=>{const select=document.querySelector('select[aria-label=\"Chat provider\"]');for(const value of ['OpenAI','OpenRouter']){select.value=value;select.dispatchEvent(new Event('change'));}})()",
  );
  await until(
    "document.querySelector('.agents-accordion .agents-connection-state.failed')?.textContent.includes('HTTP 401')",
  );
  await screenshot("agents-openrouter-auth-failure");
  // The provider list names kinds only. A custom server is one profile per base URL (saving it again
  // under the legacy family or with a trailing slash updates it) and is edited from Connected providers.
  const custom = await evaluate(
    `(async()=>{const p=(method,params)=>window.crot.product(method,params);try{const a=await p('chat.configure',{provider:'Custom API',endpoint:${JSON.stringify(endpoint)},credential:'fixture-ui-agents-key'});const b=await p('chat.configure',{provider:'OpenAI-compatible',endpoint:${JSON.stringify(endpoint + "/")}});await p('chat.testConnection',{provider:a.provider});const profiles=(await p('chat.providers')).providers.filter(v=>v.provider.includes(':'));return {a:a.provider,b:b.provider,profiles:profiles.map(v=>v.provider),connected:profiles.every(v=>v.connectionStatus==='connected'&&v.credentialStored)};}catch(error){return {error:String(error?.message||error)};}})()`,
  );
  assert(
    !custom.error &&
      custom.a.startsWith("Custom API:") &&
      custom.b === custom.a &&
      custom.profiles.length === 1 &&
      custom.profiles[0] === custom.a &&
      custom.connected,
    "One custom server was saved as several profiles: " + JSON.stringify(custom),
  );
  await evaluate("document.getElementById('nav-agents').click()");
  await until(
    `!document.querySelector('[data-provider-loading]')&&document.querySelector('[data-connected-provider=${JSON.stringify(custom.a)}]')`,
  );
  assert(
    (await evaluate(
      "JSON.stringify([...document.querySelector('select[aria-label=\"Chat provider\"]').options].map(o=>o.value))",
    )) ===
      JSON.stringify(["OpenAI", "Anthropic", "Google Gemini", "OpenRouter", "OpenCode (Free & Zen)", "Custom API"]),
    "Provider list shows saved profiles instead of provider kinds",
  );
  await evaluate(
    `document.querySelector('[data-connected-provider=${JSON.stringify(custom.a)}] [data-connected-configure]').click()`,
  );
  assert(
    await evaluate(
      `document.querySelector('select[aria-label="Chat provider"]').value==='Custom API'&&[...document.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent==='API base URL').querySelector('input').value===${JSON.stringify(endpoint)}`,
    ),
    "Configure did not open the saved custom server",
  );
  await screenshot("agents-custom-server-profile");
  assert(
    await evaluate(
      `(async()=>{await window.crot.product('chat.remove',{provider:${JSON.stringify(custom.a)}});return true;})()`,
    ),
    "Custom server removal failed",
  );
  // Disconnect removes provider configuration and its vault secret, with no secret in audit.
  for (const provider of ["OpenCode", "Notion Agents"]) {
    assert(
      await evaluate(
        `(async()=>{await window.crot.product('chat.remove',{provider:${JSON.stringify(provider)}});const p=(await window.crot.product('chat.providers')).providers.find(p=>p.provider===${JSON.stringify(provider)});return !p.configured&&!p.credentialStored;})()`,
      ),
      "Workspace disconnect retained credentials",
    );
  }
  const agentAudit = await readFile(path.join(real.base, "audit.jsonl"), "utf8");
  assert(
    !["fixture-opencode-password", "fixture-notion-agents-key"].some((key) => agentAudit.includes(key)),
    "Workspace secret leaked into audit",
  );
  await writeFile(
    path.join(artifacts, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        scope:
          "Real CrotService token registry/audit and HTTP model/chat fixture. No live vendor credentials or paired relay invented.",
        tokensRotated: true,
        cloudSaveTest: true,
        localModels: true,
        chatUsingSavedProvider: true,
        sidebarUnchanged: true,
        nativeOpenCodeAndNotionAgentChats: true,
        conditionalAccordionFit: true,
        river401SafeDiagnostic: true,
        exclusiveAccordionFrames: true,
        workspaceDisconnectRemovesSecret: true,
        authorizationMethodsPanel: true,
        openCodeFreeZenForm: true,
        everyProviderHasCheck: true,
      },
      null,
      2,
    ),
  );
}
