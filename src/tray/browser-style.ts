/** Browser screen (central area only; the sidebar is untouched): header, CROT Extension status card, policy cards with
 *  switches and the open tabs list. Built on the design tokens, so light and dark themes follow automatically. */
export const BROWSER_CSS = String.raw`
.browser-page{--browser-ok:#22c55e;--browser-wait:#f59e0b;display:flex;flex-direction:column;gap:3px;min-width:0;color:var(--text);font-size:14px;line-height:1.35}
:root[data-theme=dark] .browser-page{--browser-ok:var(--success);--browser-wait:var(--warning)}
.browser-page *{box-sizing:border-box}.browser-page [hidden]{display:none!important}
.browser-page p{margin:0}.browser-page .badge{margin:0}
.browser-head{display:flex;align-items:center;gap:12px;min-width:0;padding:0}.browser-head .browser-emblem{--size:40px}
.browser-head-copy{flex:1;min-width:0}
.browser-head h1{margin:0;font-size:24px;line-height:28px;font-weight:700;letter-spacing:-.4px}
.browser-head-copy p{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--text-muted)}
.browser-saved{flex:none;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--success-tint);color:var(--success);font-size:13px;line-height:18px;font-weight:600;max-width:min(420px,45%)}
.browser-saved svg{flex:none;width:16px;height:16px}
.browser-saved.browser-saved-error{background:var(--danger-tint);color:var(--danger)}
/* A round browser emblem (CSS only); tinted after the connected browser. */
.browser-emblem{--size:52px;position:relative;display:inline-block;flex:none;width:var(--size);height:var(--size);border-radius:50%;background:conic-gradient(from -30deg,#ea4335 0 120deg,#fbbc04 0 240deg,#34a853 0 360deg);box-shadow:0 2px 6px rgba(15,23,42,.18)}
.browser-emblem::after{content:'';position:absolute;inset:29%;border-radius:50%;background:#4285f4;box-shadow:0 0 0 calc(var(--size)*.075) #fff}
.browser-emblem[data-browser=chromium]{background:conic-gradient(from -30deg,#1a73e8 0 120deg,#8ab4f8 0 240deg,#5e97f6 0 360deg)}
.browser-emblem[data-browser=chromium]::after{background:#1a73e8}
.browser-emblem[data-browser=edge]{background:conic-gradient(from 200deg,#0c59a4,#1b9de2,#35c1f1,#5ad075,#0c59a4)}
.browser-emblem[data-browser=edge]::after{background:#0c59a4}
.browser-emblem[data-browser=brave]{background:linear-gradient(135deg,#ff7a4d,#fb542b 55%,#d6380f)}
.browser-emblem[data-browser=brave]::after{background:#fb542b}
/* CROT Extension status card */
.browser-status{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px 12px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);box-shadow:var(--shadow-card)}
.browser-status[data-state=connected]{background:var(--success-tint);border-color:color-mix(in srgb,var(--browser-ok) 38%,var(--border))}
.browser-status:is([data-state=waiting],[data-state=pairing],[data-state=update_required],[data-state=in_use]){background:var(--warning-tint);border-color:color-mix(in srgb,var(--browser-wait) 40%,var(--border))}
.browser-status-tile{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--bg-surface);box-shadow:var(--shadow-card)}
.browser-status-tile .browser-emblem{--size:28px}
.browser-status-copy{min-width:0;display:flex;flex-direction:column;gap:4px}
.browser-status h2{display:flex;align-items:center;gap:10px;margin:0;font-size:14px;line-height:18px;font-weight:700;letter-spacing:-.2px}
.browser-status-copy>p{font-size:12px;line-height:16px;color:var(--text-muted)}
.browser-status-note:empty,.browser-identity:empty{display:none}
.browser-status-copy>.browser-identity{font-size:11px;line-height:14px}
.browser-status-note{color:var(--warning)!important;font-weight:500}
.browser-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--text-muted)}
.browser-status[data-state=connected] .browser-dot{background:var(--browser-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--browser-ok) 25%,transparent)}
.browser-status:is([data-state=waiting],[data-state=pairing],[data-state=update_required],[data-state=in_use]) .browser-dot{background:var(--browser-wait);box-shadow:0 0 0 3px color-mix(in srgb,var(--browser-wait) 25%,transparent)}
.browser-status:is([data-state=waiting],[data-state=pairing],[data-state=checking]) .browser-dot{animation:browser-pulse 1.6s ease-in-out infinite}
@keyframes browser-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.browser-status-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.browser-status-actions button{min-height:34px;padding:6px 10px;border-radius:10px;background:var(--bg-surface);border:1px solid var(--border-strong);font-weight:500;white-space:nowrap}
.browser-status-actions button.primary{background:var(--primary);border-color:var(--primary);color:var(--text-on-primary)}
.browser-requests:empty,.browser-trusted:empty{display:none}
.browser-requests{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.browser-request{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-surface)}
.browser-code{font-size:24px;line-height:30px;font-weight:700;letter-spacing:.08em;font-variant-numeric:tabular-nums}
.browser-request-who{flex:1;min-width:120px;color:var(--text-muted);font-size:13px}
.browser-request .actions{margin:0;gap:8px}
.browser-request button{min-height:36px;padding:6px 14px;border-radius:10px}
.browser-trusted{margin-top:6px}
.browser-trusted summary{cursor:pointer;color:var(--text-muted);font-size:13px}
.browser-trusted ul{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.browser-trusted li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}
.browser-trusted li button{min-height:30px;padding:4px 12px;border-radius:8px;font-size:12px}
/* Policy cards: an icon column, a head and rows with switches on the right. */
.browser-card{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:6px 16px 2px;box-shadow:var(--shadow-card);min-width:0}
.browser-line{display:grid;grid-template-columns:32px minmax(0,1fr);column-gap:12px;align-items:start}
.browser-line-icon{display:flex;justify-content:center;color:var(--text)}
.browser-line-icon svg{width:22px;height:22px;stroke-width:1.6}
.browser-card-danger .browser-line-head .browser-line-icon{color:var(--danger)}
.browser-card-danger .browser-line-head .browser-line-icon svg{stroke-width:2}
.browser-line-head{padding-bottom:2px}
.browser-card-head h2{margin:0;font-size:14px;line-height:18px;font-weight:700;letter-spacing:-.2px}
.browser-card-head p{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--text-muted)}
.browser-line-row>:last-child{border-top:1px solid var(--border);padding:2px 0}
.browser-line-row .browser-line-icon{padding-top:10px}
.browser-line-note>:last-child,.browser-line-body>:last-child{padding:0 0 4px}
.browser-row{display:flex;align-items:center;justify-content:space-between;gap:20px;min-width:0}
.browser-row-copy{min-width:0}
.browser-row-copy h3{margin:0;font-size:14px;line-height:18px;font-weight:600}
.browser-row-copy>p{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--text-muted)}
.browser-row-body{display:flex;flex-direction:column;min-width:0}
.browser-hint{margin:2px 0 0!important;font-size:12px;line-height:15px;color:var(--text-muted)}
.browser-hint-warning{color:var(--warning)}
.browser-switch{flex:none;display:inline-flex;align-items:center;cursor:pointer}
.browser-page .browser-switch input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:48px;min-width:48px;height:28px;min-height:28px;margin:0;padding:0;border:0;border-radius:14px;background:var(--border-strong);cursor:pointer;transition:background var(--dur) var(--ease)}
.browser-page .browser-switch input[type=checkbox]::before{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.3);transition:transform var(--dur) var(--ease)}
.browser-page .browser-switch input[type=checkbox]:checked{background:var(--primary)}
.browser-page .browser-switch input[type=checkbox]:checked::before{transform:translateX(20px)}
.browser-page .browser-switch input[type=checkbox]:disabled{opacity:.5;cursor:default}
.browser-page .browser-switch input[type=checkbox]:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.browser-input{display:flex;align-items:center;gap:10px;margin-top:3px;height:34px;padding:0 14px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-surface);color:var(--text-muted)}
.browser-input svg{flex:none;width:18px;height:18px}
.browser-page .browser-input input{flex:1;min-width:0;height:32px;min-height:0;margin:0;padding:0;border:0;border-radius:0;background:transparent;font-size:14px;color:var(--text);outline:none;box-shadow:none}
.browser-input:focus-within{border-color:var(--primary);box-shadow:var(--focus-ring)}
.browser-row-off .browser-input{opacity:.55}
.browser-page input::placeholder,.browser-page textarea::placeholder{color:var(--text-muted);opacity:.85}
.browser-page .browser-blocked textarea{display:block;width:100%;min-height:44px;margin:0;padding:4px 10px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-surface);font-size:14px;line-height:21px;color:var(--text);resize:vertical}
.browser-page .browser-blocked textarea:focus-visible{outline:none;border-color:var(--primary);box-shadow:var(--focus-ring)}
/* Open tabs */
.browser-tab-list{display:flex;flex-direction:column;min-width:0}
.browser-tab{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 0;border-top:1px solid var(--border)}
.browser-tab:first-child{border-top:0;padding-top:2px}
.browser-tab>svg{flex:none;width:18px;height:18px;color:var(--text-muted)}
.browser-tab-copy{flex:1;min-width:0;display:flex;flex-direction:column}
.browser-tab-title{font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.browser-tab-url{font-size:12px;line-height:17px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.browser-tab-marks{flex:none;display:flex;gap:6px}
.browser-tab-list .empty{padding:20px 16px}
/* Install guide (dialog) */
.browser-steps{margin:12px 0 16px;padding-left:22px;display:flex;flex-direction:column;gap:10px}
.browser-steps p{margin:2px 0 0}
a.browser-link-button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:8px;border:1px solid var(--border);text-decoration:none;font-weight:600;color:var(--text)}
a.browser-link-button.primary{background:var(--primary);border-color:var(--primary);color:var(--text-on-primary)}
@media(max-width:960px){.browser-status{grid-template-columns:auto minmax(0,1fr)}.browser-status-actions{grid-column:1/-1;justify-content:flex-start}}
@media(max-width:760px){.browser-card{padding:16px 16px 4px}.browser-line{grid-template-columns:28px minmax(0,1fr);column-gap:10px}.browser-line-icon svg{width:22px;height:22px}.browser-status{grid-template-columns:minmax(0,1fr);padding:16px}.browser-status-tile{display:none}.browser-head .browser-emblem{--size:40px}.browser-head h1{font-size:22px;line-height:28px}.browser-saved{max-width:100%}}
@media(prefers-reduced-motion:reduce){.browser-dot{animation:none!important}.browser-page .browser-switch input[type=checkbox],.browser-page .browser-switch input[type=checkbox]::before{transition:none}}
`;
