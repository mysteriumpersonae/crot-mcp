/** Only Agents central content; sidebar/header geometry is intentionally untouched.
 *  One neutral family on the design tokens (light and dark), one accent (primary) and semantic status colours.
 *  Every control in a row shares one height (--agents-control); groups are separated by space, cards and one
 *  sunken shade instead of extra borders. */
export const AGENTS_CENTER_CSS = String.raw`
.agents-active main.content{width:100%;max-width:none;margin:0;padding:24px;background:var(--bg-app);height:100%;min-height:0;overflow-y:auto}
.agents-active #page{min-height:0}
.agents-active #notice:empty{display:none}.agents-active #notice:not(:empty){margin:0 0 16px}
.agents-center{--agents-control:32px;display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;min-width:0;color:var(--text);font-size:13px;line-height:1.45}
.agents-center *{box-sizing:border-box}.agents-center [hidden]{display:none!important}
.agents-center p{margin:0}
.agents-column{min-width:0;display:grid;grid-row:span 2;grid-template-rows:subgrid;row-gap:12px}
.agents-column-body{min-width:0;display:flex;flex-direction:column;gap:12px}
.agents-column-body>*{flex-shrink:0}
/* Column heads: a small neutral outline icon, the title and one line of description. */
.agents-column-head{display:flex;align-items:flex-start;align-self:start;gap:12px;padding:0 4px;min-height:40px}
.agents-column-head>div{min-width:0}
.agents-column-head h1{margin:0;font-size:16px;line-height:22px;font-weight:600;letter-spacing:-.1px;color:var(--text)}
.agents-column-head p{margin:2px 0 0;font-size:13px;line-height:18px;color:var(--text-muted)}
.agents-tile{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:var(--bg-sunken);color:var(--text-muted)}
.agents-tile svg{width:18px;height:18px}
.agents-column-head .agents-tile{background:var(--bg-surface);border:1px solid var(--border)}
/* Cards: one surface, one border, one radius; content stacks with a 16px rhythm. */
.agents-card{min-width:0;background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:var(--shadow-card)}
section.agents-card{display:flex;flex-direction:column;gap:16px}
.agents-card-head{display:flex;flex-direction:column;gap:4px}
.agents-card h2{margin:0;font-size:15px;line-height:20px;font-weight:600;letter-spacing:-.1px;color:var(--text)}
.agents-description{margin:0;font-size:13px;line-height:18px;color:var(--text-muted)}
.agents-section{display:flex;flex-direction:column;gap:12px;padding-top:16px;border-top:1px solid var(--border)}
.agents-field-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.agents-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.agents-note{margin:0;font-size:12px;line-height:17px;color:var(--text-muted)}
.agents-note:empty{display:none}
/* Fields */
.agents-center .field{display:flex;flex-direction:column;gap:6px;margin:0;min-width:0}
.agents-center .field>span{font-size:13px;line-height:18px;font-weight:500;color:var(--text)}
.agents-center input:not([type=checkbox],[type=radio]),.agents-center select{width:100%;min-width:0;height:var(--agents-control);min-height:var(--agents-control);padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);color:var(--text);font:400 13px/1.4 var(--font-ui);box-shadow:none}
.agents-center input::placeholder{color:var(--text-muted);opacity:.85}
.agents-center input:not([type=checkbox],[type=radio]):focus-visible{outline:none;border-color:var(--primary);box-shadow:var(--focus-ring)}
.agents-center input[readonly]{background:var(--bg-sunken);border-color:var(--border)}
.agents-center input[readonly]:not([type=password]):not(:placeholder-shown){font-family:var(--font-mono);font-size:12px}
.agents-input-row,.agents-key-row{display:flex;align-items:center;gap:8px;min-width:0}
.agents-input-row>input{flex:1}
.agents-key-row>button{flex:none}
.agents-key-input{position:relative;flex:1;min-width:0}
.agents-center .agents-key-input input{padding-right:36px}
/* Buttons: one height per row, 13px/500, neutral by default; primary only for the main action of a form. */
.agents-center button,.agents-center a.agents-button{min-height:var(--agents-control);padding:5px 12px;gap:6px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);color:var(--text);font:500 13px/18px var(--font-ui);text-align:center;justify-content:center;box-shadow:none}
.agents-center a.agents-button{display:inline-flex;align-items:center;text-decoration:none}
.agents-center button:hover:not(:disabled),.agents-center a.agents-button:hover{background:var(--bg-sunken);border-color:var(--border-strong)}
.agents-center button svg,.agents-center a.agents-button svg{width:16px;height:16px}
.agents-center button.primary{background:var(--primary);border-color:var(--primary);color:var(--text-on-primary)}
.agents-center button.primary:hover:not(:disabled){background:var(--primary-hover);border-color:var(--primary-hover)}
.agents-center .agents-small{min-height:28px;padding:4px 10px;font-size:12px;line-height:18px}
.agents-center .agents-danger{color:var(--danger)}
.agents-center .agents-danger:hover:not(:disabled){background:var(--danger-tint);border-color:var(--danger-tint)}
.agents-center .agents-icon-button{flex:none;width:var(--agents-control);min-width:var(--agents-control);height:var(--agents-control);padding:0;color:var(--text-muted)}
.agents-center .agents-icon-button:hover:not(:disabled){color:var(--text)}
.agents-center .agents-icon-button[aria-pressed=true]{background:var(--bg-sunken);color:var(--text)}
.agents-center .agents-key-input .agents-icon-button{position:absolute;top:1px;right:1px;width:30px;min-width:30px;height:calc(var(--agents-control) - 2px);min-height:0;border:0;border-radius:7px;background:transparent}
.agents-center .agents-key-input .agents-icon-button:hover:not(:disabled),.agents-center .agents-key-input .agents-icon-button[aria-pressed=true]{background:var(--bg-sunken)}
.agents-center .agents-copied{color:var(--success);font-weight:600}
/* Selects: the Unified Chat popover, sized like every other control. */
.agents-choice{min-width:0;width:100%}
.agents-center .agents-choice-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0;height:var(--agents-control);min-height:var(--agents-control);padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);font-weight:400;text-align:left}
.agents-center .agents-choice-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-center .agents-choice-trigger>svg{flex:none;width:16px;height:16px;margin-left:auto;color:var(--text-muted)}
.agents-center .agents-choice-trigger[aria-expanded=true]{border-color:var(--primary);box-shadow:var(--focus-ring)}
.agents-center .chat-popover{z-index:20;padding:4px;border:1px solid var(--border);border-radius:10px;background:var(--bg-surface);color:var(--text);box-shadow:var(--shadow-pop)}
.agents-center .chat-menu-item{min-height:32px;padding:6px 10px;border:0;border-radius:6px;background:transparent;font-weight:400;justify-content:flex-start;text-align:left}
.agents-center .chat-menu-item:hover:not(:disabled){background:var(--bg-sunken)}
.agents-center .chat-menu-item[aria-pressed=true]{background:var(--primary-tint);color:var(--interactive-text)}
.agents-center .chat-check{color:var(--interactive-text)}
/* A sunken panel groups one control row with its live status. */
.agents-panel{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px;background:var(--bg-sunken)}
.agents-panel-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}
.agents-switch{display:inline-flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:500;cursor:pointer}
.agents-switch input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:32px;min-width:32px;height:18px;min-height:18px;margin:0;padding:0;border:0;border-radius:9px;background:var(--border-strong);cursor:pointer;transition:background var(--dur) var(--ease)}
.agents-switch input[type=checkbox]::before{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.25);transition:transform var(--dur) var(--ease)}
.agents-switch input[type=checkbox]:checked{background:var(--primary)}
.agents-switch input[type=checkbox]:checked::before{transform:translateX(14px)}
.agents-switch input[type=checkbox]:disabled{opacity:.6;cursor:default}
/* Inline code reads as text; command rows are boxed like an input. */
.agents-center code{display:inline;margin:0;padding:1px 5px;border-radius:4px;background:var(--bg-sunken);color:var(--text);font:12px/1.5 var(--font-mono);white-space:normal;overflow-wrap:anywhere}
.agents-panel code{background:var(--bg-surface)}
.agents-install-row{display:flex;align-items:center;gap:8px;min-width:0}
.agents-center .agents-install-row code{flex:1;min-width:0;display:flex;align-items:center;height:var(--agents-control);padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);white-space:nowrap;overflow-x:auto;overflow-y:hidden}
/* Status: a dot and a short line; colour only for meaning. */
.agents-connection-state{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:17px;font-weight:500;color:var(--text-muted)}
.agents-connection-state::before{content:'';flex:none;width:8px;height:8px;border-radius:50%;background:var(--border-strong)}
.agents-connection-state.connected{color:var(--success)}.agents-connection-state.connected::before{background:var(--success)}
.agents-connection-state.failed{color:var(--danger)}.agents-connection-state.failed::before{background:var(--danger)}
.agents-connection-state.warning{color:var(--warning)}.agents-connection-state.warning::before{background:var(--warning)}
.agents-connection-state:empty{display:none}
.agents-live-status{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;min-width:0}
.agents-live-status:not(:has(>:not(:empty))){display:none}
.agents-checked{font-size:12px;color:var(--text-muted);white-space:nowrap}
/* Connected providers and the saved local server: one bordered list, a row each. */
.agents-connected{display:flex;flex-direction:column;gap:8px;min-width:0}
.agents-connected h3{margin:0;font-size:12px;line-height:16px;font-weight:600;color:var(--text-muted)}
.agents-list{border:1px solid var(--border);border-radius:8px;min-width:0}
.agents-list-row{display:flex;align-items:center;gap:10px;min-width:0;min-height:48px;padding:8px 8px 8px 12px}
.agents-list-row+.agents-list-row{border-top:1px solid var(--border)}
.agents-list-row>button{flex:none}
.agents-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--border-strong)}
.agents-dot.connected{background:var(--success)}.agents-dot.failed{background:var(--danger)}
.agents-list-mark{flex:none;display:grid;place-items:center;width:20px;height:20px;color:var(--text-muted)}
.agents-list-mark>svg,.agents-list-mark>img{width:20px;height:20px;object-fit:contain}
.agents-list-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;line-height:1.35}
.agents-list-text strong,.agents-list-text small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-list-text strong{font-size:13px;font-weight:600;color:var(--text)}
.agents-list-text small{font-size:12px;color:var(--text-muted)}
/* Outbound: two exclusive accordions. */
.agents-accordion{padding:0}
.agents-accordion>summary{display:flex;align-items:center;gap:12px;min-height:56px;padding:12px 16px;border-radius:12px;cursor:pointer;list-style:none}
.agents-accordion>summary::-webkit-details-marker{display:none}
.agents-accordion-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.agents-accordion-title p{font-size:12px;line-height:17px;color:var(--text-muted)}
.agents-chevron{flex:none;width:16px;height:16px;color:var(--text-muted);transition:transform var(--dur) var(--ease)}
.agents-accordion>summary:hover .agents-chevron{color:var(--text)}
.agents-accordion[open]>summary .agents-chevron{transform:rotate(180deg)}
.agents-accordion-body{display:flex;flex-direction:column;gap:16px;padding:16px;border-top:1px solid var(--border)}
.agents-accordion::details-content{interpolate-size:allow-keywords;height:0;overflow:clip;transition:height 200ms var(--ease),content-visibility 200ms allow-discrete}
.agents-accordion[open]::details-content{height:auto}
/* Inline disclosures (other authorization methods) and the collapsed MCP clients card. */
.agents-disclosure>summary{display:flex;align-items:center;gap:6px;width:fit-content;min-height:24px;cursor:pointer;list-style:none;font-size:13px;font-weight:500;color:var(--text-muted)}
.agents-disclosure>summary::-webkit-details-marker{display:none}
.agents-disclosure>summary:hover{color:var(--text)}
.agents-disclosure>summary>svg{flex:none;width:14px;height:14px;transform:rotate(-90deg);transition:transform var(--dur) var(--ease)}
.agents-disclosure[open]>summary>svg{transform:none}
.agents-disclosure-body{display:flex;flex-direction:column;gap:12px;padding-top:12px}
.agents-auth-group{display:flex;flex-direction:column;gap:8px}
.agents-auth-group h3{margin:4px 0 0;font-size:12px;line-height:16px;font-weight:600;color:var(--text-muted)}
.agents-auth-group .field>span{font-size:12px}
.agents-clients{padding:0}
.agents-clients>summary{width:auto;justify-content:space-between;min-height:48px;padding:12px 16px;border-radius:12px;font-size:14px;font-weight:600;color:var(--text)}
.agents-clients>summary>svg{width:16px;height:16px;transform:none;color:var(--text-muted)}
.agents-clients[open]>summary>svg{transform:rotate(180deg)}
.agents-clients>.agents-disclosure-body{padding:16px;border-top:1px solid var(--border)}
.agents-clients .panel{margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none}
.agents-clients .panel+.panel{padding-top:16px;border-top:1px solid var(--border)}
.agents-clients .panel h2{font-size:13px;line-height:18px}
.agents-clients .card{margin-top:8px;padding:12px;border:1px solid var(--border);border-radius:8px;box-shadow:none}
.agents-clients .card h3{font-size:13px}
.agents-clients .muted{font-size:12px}
.agents-clients .actions{margin-top:8px}
.agents-clients .field{margin:8px 0}
/* Copy confirmation: a small toast, never a layout shift. */
.agents-copy-status{position:fixed;right:24px;bottom:24px;z-index:50;margin:0;padding:8px 12px;border-radius:8px;background:var(--text);color:var(--bg-surface);font-size:13px;font-weight:500;box-shadow:var(--shadow-pop);pointer-events:none}
.agents-copy-status:empty{display:none}
.agents-copy-status[data-tone=error]{background:var(--danger);color:#fff}
/* Official integrations: compact neutral tiles; the logos keep their own colours. */
.agents-integrations-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.agents-integration-tile{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;color:var(--text);text-decoration:none;transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.agents-integration-tile:hover{background:var(--bg-sunken);border-color:var(--border-strong)}
.agents-integration-logo{flex:none;display:flex;width:28px;height:28px}
.agents-integration-logo svg{display:block;width:28px;height:28px;border-radius:6px}
.agents-integration-info{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.agents-integration-name{font-size:13px;font-weight:600;color:var(--text)}
.agents-connect-link{font-size:12px;font-weight:500;color:var(--interactive-text)}
/* OpenCode (Free & Zen): key link, local auto-connect, route and install hint. */
.agents-zen-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.agents-zen-route{color:var(--success)}
.agents-zen-check{color:var(--warning)}
.agents-zen-install{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border-radius:8px;background:var(--bg-sunken)}
.agents-zen-install>.agents-install-row{align-self:stretch}
.agents-install-failed{color:var(--danger)}
.agents-link{font-size:13px;font-weight:500;color:var(--interactive-text);text-decoration:none}
.agents-link:hover{text-decoration:underline}
/* Local models: server chips, its setup hint and the exact API endpoint. */
.agents-presets{display:flex;flex-wrap:wrap;gap:6px}
.agents-center .agents-chip{min-height:28px;padding:4px 12px;border-radius:999px;font-size:12px;line-height:18px}
.agents-center .agents-chip[aria-pressed=true]{background:var(--primary-tint);border-color:var(--primary);color:var(--interactive-text)}
.agents-local-preview.agents-invalid{color:var(--danger)}
.agents-center button:focus-visible,.agents-center a:focus-visible,.agents-center summary:focus-visible,.agents-switch input[type=checkbox]:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
/* Remove-credential confirmation (a modal dialog outside the page). */
dialog.agents-confirm{max-width:min(420px,calc(100vw - 32px));padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--bg-surface);color:var(--text);box-shadow:var(--shadow-pop)}
dialog.agents-confirm p{margin:0;font-size:14px;line-height:20px}
dialog.agents-confirm .actions{margin-top:16px;justify-content:flex-end;gap:8px}
dialog.agents-confirm button{min-height:32px;padding:5px 12px;border-radius:8px;font-size:13px;font-weight:500}
@media(prefers-reduced-motion:reduce){.agents-accordion::details-content,.agents-chevron,.agents-disclosure>summary>svg,.agents-switch input[type=checkbox],.agents-switch input[type=checkbox]::before,.agents-integration-tile{transition:none}}
@media(max-width:1199px){.agents-center{grid-template-columns:1fr}}
@media(max-width:760px){
.agents-active main.content{padding:16px 12px}
.agents-center{--agents-control:36px;gap:16px}
.agents-card{padding:12px}
section.agents-card{gap:12px}
.agents-accordion,.agents-clients{padding:0}
.agents-accordion>summary,.agents-clients>summary{padding:12px}
.agents-accordion-body,.agents-clients>.agents-disclosure-body{padding:12px;gap:12px}
.agents-key-row{flex-wrap:wrap}
.agents-key-row>.agents-key-input{flex-basis:100%}
.agents-key-row>button{flex:1}
.agents-list-row{flex-wrap:wrap;padding:8px 12px}
.agents-list-text{flex-basis:calc(100% - 48px)}
.agents-list-row>button{flex:1}
.agents-integration-tile{flex-direction:column;justify-content:center;gap:6px;padding:10px 6px;text-align:center}
.agents-integration-info{align-items:center}
.agents-center .agents-key-input .agents-icon-button{width:34px;min-width:34px}
}
`;
