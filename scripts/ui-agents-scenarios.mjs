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
  screenshot,
  navigate,
  call,
  artifacts,
  assert,
}) {
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
  assert(await evaluate("!document.querySelector('[data-relay-url]').value"), "Unpaired device invented a relay URL");
  const sidebar = await evaluate("document.querySelector('.sidebar').getBoundingClientRect().width");
  await call("Browser.grantPermissions", {
    origin: new URL(await evaluate("location.href")).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await evaluate(
    "document.querySelector('.agents-local-access').open=true;document.querySelector('[data-generate-token]').click()",
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
  await until("document.querySelector('.agents-copy-status').textContent==='Copied'");
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
  const journal = await readFile(path.join(real.base, "audit.jsonl"), "utf8");
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
    await evaluate("document.querySelector('.chat-agents .chat-selector').click()");
    await until("document.querySelector('.chat-popover:popover-open')");
    await until(
      `[...document.querySelectorAll('.chat-popover:popover-open button')].some(b=>b.textContent.includes(${JSON.stringify(saved.defaultModel)}))`,
    );
    await evaluate(
      `[...document.querySelectorAll('.chat-popover:popover-open button')].find(b=>b.textContent.includes(${JSON.stringify(saved.defaultModel)})).click()`,
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
  await evaluate("document.querySelector('main.content').scrollTop=0");
  await size(1584, 960);
  await evaluate("window.CrotI18n.setLanguage('en')");
  await until("document.querySelector('[data-integration=Notion]')");
  for (const name of ["Notion", "Claude", "n8n"]) {
    await evaluate(`document.querySelector('[data-integration="${name}"]').click()`);
    await until("document.getElementById('action-dialog').open");
    assert(
      await evaluate("document.getElementById('action-dialog').textContent.includes('Pair your device')"),
      "Unpaired integration fabricated config",
    );
    await evaluate("document.getElementById('action-dialog').close()");
  }
  // Presentation-only paired URL: exercise recipes/copy without claiming a live paired relay.
  const recipeUrl = "https://mcp.crot.network/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/mcp";
  await evaluate(
    `(async()=>{const v=await window.crot.request('view');window.originalViewRender=window.crot.render;window.crot.render=next=>window.originalViewRender({...next,resourceUri:${JSON.stringify(recipeUrl)}});window.crot.render(v);document.getElementById('nav-agents').click();})()`,
  );
  await until("document.querySelector('[data-relay-url]').value.includes('mcp.crot.network')");
  await evaluate("document.querySelector('[aria-label=\"Copy relay URL\"]').click()");
  await until(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(recipeUrl)})()`);
  for (const name of ["Notion", "Claude", "n8n"]) {
    await evaluate(`document.querySelector('[data-integration="${name}"]').click()`);
    await until("document.getElementById('action-dialog').open");
    assert(
      await evaluate(
        `document.querySelector('#action-dialog pre')?.textContent.includes(${JSON.stringify(recipeUrl)})`,
      ),
      "Paired recipe missing canonical URL",
    );
    await evaluate(
      "[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Copy configuration').click()",
    );
    await until("document.querySelector('#action-dialog [data-copy-status]')?.textContent==='Copied'");
    assert((await evaluate("navigator.clipboard.readText()")).includes(recipeUrl), "Configuration clipboard failed");
    await screenshot("agents-setup-" + name.toLowerCase());
    await evaluate("document.getElementById('action-dialog').close()");
  }
  await evaluate("document.getElementById('nav-chat').click()");
  await until("[...document.querySelectorAll('.chat-agent-pill')].some(b=>b.textContent==='OpenAI')");
  await evaluate("[...document.querySelectorAll('.chat-agent-pill')].find(b=>b.textContent==='OpenAI').click()");
  await evaluate(
    "(()=>{const m=document.querySelector('.chat-compose textarea');m.value='Real saved provider check';m.dispatchEvent(new Event('input'));document.querySelector('.chat-send').click();})()",
  );
  await until(
    "[...document.querySelectorAll('.chat-message-text')].some(n=>n.textContent.includes('Real provider fixture response'))",
  );
  await evaluate("window.crot.render=window.originalViewRender");
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
        workspaceDisconnectRemovesSecret: true,
      },
      null,
      2,
    ),
  );
}
