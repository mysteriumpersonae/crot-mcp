/** Unified Chat only: leave the shared sidebar and Home geometry untouched. */
export const CHAT_CSS = String.raw`
.chat-compose-left{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.chat-browser-toggle{display:grid;place-items:center;width:28px;min-width:28px;height:28px;min-height:28px;padding:3px;border:1px solid var(--border);border-radius:7px;background:var(--bg-surface);color:var(--text-muted);cursor:pointer}.chat-browser-toggle svg{width:20px;height:20px}.chat-browser-toggle.active{color:var(--primary);background:var(--primary-tint, #e8f0ff);border-color:var(--primary)}.chat-browser-toggle:focus-visible{outline:2px solid var(--primary);outline-offset:2px}

.chat-active main.content{width:100%;height:100%;align-self:stretch;margin:0;padding:20px;overflow:hidden;max-width:none;background:linear-gradient(135deg,#fcfdff,#f7faff)}
.chat-active #notice{display:none}.chat-active #page{height:100%;min-height:0}
.chat-workspace{--shadow-pop:0 14px 48px #172c5426,0 3px 12px #172c5410;height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;color:#172047}
.chat-stage{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #e4ebfc;border-radius:20px 20px 0 0;border-bottom:0;margin-bottom:-12px;background:radial-gradient(ellipse at center,#fff8,transparent 75%);overflow:hidden}
.chat-welcome{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:24px}
.chat-glow{display:grid;place-items:center;width:112px;height:112px;min-height:112px;border:5px solid #f4f7ff;border-radius:50%;background:#e7eeff;color:#1970ff;box-shadow:inset 0 0 0 2px #fff,0 0 32px #c9d9ff30;margin-bottom:18px}.chat-glow svg{width:48px;height:48px;stroke-width:1.8}
.chat-welcome h1{font-size:28px;line-height:1.3;letter-spacing:-.7px;margin:0 0 10px;color:#141937}
.chat-intro{font-size:18px;line-height:1.5;color:#657396;max-width:520px;margin:0 0 30px}
.chat-starters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;width:100%;max-width:580px}
.chat-starter{min-height:58px;border:1px solid #e0e8fc;border-radius:15px;padding:14px 18px;background:#ffffffb3;color:#43527c;gap:16px;justify-content:flex-start}.chat-starter svg{color:#216aff}.chat-starter:nth-child(2) svg{color:#a531ee}.chat-starter:nth-child(3) svg{color:#f21d33}.chat-starter:nth-child(4) svg{color:#f5820c}
.chat-selectors{display:flex;align-items:center;justify-content:space-between;border:1px solid #e4ebfc;border-top:0;border-radius:0 0 20px 20px;padding:8px 18px;gap:16px;min-height:62px}
.chat-dropdown{min-width:0}.chat-workspace .chevron{display:inline-block!important;margin-left:auto;color:#52678f;font-size:18px;line-height:1;min-width:12px}.chat-selector{border:1px solid #e0e8fc;border-radius:15px;min-width:210px;min-height:46px;padding:9px 16px;background:#fff;gap:12px}.chat-selector>span:not(.chevron){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-selector>svg:last-child{margin-left:auto;width:16px;height:16px}.chat-selector .vendor-mark{width:24px;height:24px;object-fit:contain;flex-shrink:0}
.chat-popover{position:fixed;inset:auto;margin:0;width:min(340px,calc(100vw - 24px));padding:7px;border:1px solid #e3e6eb;border-radius:14px;box-shadow:var(--shadow-pop,0 14px 48px #172c5426);background:#fff;color:#202a3b;overflow:auto}
.chat-popover::backdrop{background:transparent}.chat-menu-item{display:flex;justify-content:flex-start;gap:12px;width:100%;border:0;border-radius:8px;padding:10px 12px;background:#fff;overflow-wrap:anywhere}.chat-menu-item[aria-pressed=true]{background:#f3f5f6}.chat-menu-item img{object-fit:contain;width:22px;height:22px}.chat-check{margin-left:auto;color:#159658;font-weight:600;flex-shrink:0}.chat-menu-note{padding:10px 12px;color:#617089;font-size:13px;line-height:1.5}
.chat-add{display:flex;justify-content:flex-start;width:100%;margin-top:6px;border:0;border-top:1px solid #e9edf2;border-radius:0;padding:10px 12px;background:#fff}.chat-icon-stack{margin-left:auto;display:flex;padding-left:12px}.chat-icon-stack svg{width:27px;height:27px;min-width:27px;padding:4px;margin-left:-8px;border:1px solid #e7ebf3;border-radius:50%;background:#fff;color:#617089}.chat-icon-stack img{background:#fff;border:1px solid #e7ebf3;object-fit:contain;border-radius:50%;padding:4px;width:27px;height:27px;margin-left:-8px}.chat-tool-options{border-top:1px solid #e9edf2;margin-top:6px;padding:10px 12px}.chat-tool-options summary{cursor:pointer;min-height:30px}.chat-tool-options .field{margin:4px 0;font-size:13px}
.chat-compose{border:1px solid #e4e7eb;border-radius:20px;background:#fff;padding:16px 20px 10px;box-shadow:0 2px 4px #172c5403}.chat-compose:hover{border-color:#d3d7dd}.chat-compose:focus-within{border-color:#aeb6c2;box-shadow:none}.chat-compose textarea:hover,.chat-compose textarea:focus,.chat-compose textarea:focus-visible{outline:none;outline-offset:0;box-shadow:none;border:0}.chat-compose textarea{display:block;width:100%;min-height:60px;height:60px;max-height:120px;resize:none;border:0;padding:4px;background:transparent;font-size:var(--ui-body-size);line-height:1.5;border-radius:8px}.chat-compose textarea::placeholder{color:#7482a4;opacity:1}.chat-compose-actions,.chat-send-actions{display:flex;align-items:center;justify-content:space-between;gap:16px}.chat-attach{border:0;background:transparent;padding:8px 4px;font-size:13px;color:#56678e}.chat-send-actions{gap:24px}.chat-shortcut{font-size:12px;color:#6a7b9f}.chat-send{width:44px;height:44px;min-width:44px;min-height:44px;max-width:44px;flex:0 0 44px;aspect-ratio:1;padding:0;border:0;border-radius:50%;background:#b8ceff;color:#fff;justify-content:center;transition:background .15s,box-shadow .15s}.chat-send.chat-send-ready,.chat-send[data-running=true]{background:#1a6bff}.chat-send.chat-send-ready:hover,.chat-send[data-running=true]:hover{background:#0f5ce8;box-shadow:0 0 0 4px #1a6bff26}.chat-send svg{width:21px;height:21px}
.chat-attachments{display:flex;gap:6px;flex-wrap:wrap}.chat-attachment{display:flex;align-items:center;gap:8px;font-size:12px;max-width:100%;border-radius:8px;background:#eef4ff;padding:2px 8px;overflow-wrap:anywhere}.chat-attachment button{border:0;background:none;padding:2px;min-height:30px;min-width:30px}
.chat-agents{position:relative;display:flex;align-items:center;justify-content:flex-start;gap:10px;padding:6px 2px 4px;flex-wrap:wrap;min-height:44px}.chat-agent-label{font-size:12px;color:#7485a4;white-space:nowrap}.chat-agent-pills{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-start;max-width:100%;max-height:80px;overflow:auto;padding:2px 0}
.chat-agent-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid #dce6f9;border-radius:8px;height:28px;min-height:0;padding:0 9px;background:#fff;min-width:0;font-size:12px;font-weight:500;color:#374466;cursor:pointer;white-space:nowrap;transition:border-color .12s,background .12s}
.chat-agent-pill:hover{border-color:#b8cbf5;background:#f7faff}
.chat-agent-pill[aria-pressed=true]{border-color:#1a6bff;background:#eff6ff;color:#1a4ab8}
.chat-agent-pill svg{width:14px;height:14px;flex-shrink:0}
.chat-agent-pill img{width:14px;height:14px;object-fit:contain;flex-shrink:0;border-radius:3px}
.chat-pill-model{color:#5a6fa8;font-size:11.5px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}.chat-pill-model:not(:empty)::before{content:'· ';opacity:.6}
.chat-pill-caret{color:#8099c4;font-size:11px;margin-left:1px;flex-shrink:0;opacity:.7}
.chat-online{width:6px;height:6px;min-width:6px;border-radius:50%;background:#00c75b;flex-shrink:0}
.chat-model-pop{position:absolute;top:auto;bottom:calc(100% + 8px);left:0;right:auto;z-index:30;max-height:260px;overflow-y:auto;min-width:200px;padding:5px}
.chat-model-pop .chat-menu-item{padding:6px 10px;font-size:12.5px;border-radius:6px}
.chat-model-pop-disconnect{width:100%;text-align:left;border:0;border-top:1px solid #eef0f4;border-radius:0 0 6px 6px;margin-top:4px;padding:7px 10px;background:transparent;font-size:12.5px;color:#c0392b;cursor:pointer}
.chat-model-pop-disconnect:hover{background:#fff5f5}
.chat-thread{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;flex:0 1 auto}.chat-project{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:220px;height:32px;padding:0 10px;border:1px solid #e0e8fc;border-radius:10px;background:#f7faff;color:#43527c;font-size:12.5px;white-space:nowrap}.chat-project svg{width:15px;height:15px;flex-shrink:0;color:#216aff}.chat-project span{overflow:hidden;text-overflow:ellipsis}.chat-new{display:inline-flex;align-items:center;gap:6px;height:32px;min-height:32px;padding:0 12px;border:1px solid #dce6f9;border-radius:10px;background:#fff;color:#1a4ab8;font-size:12.5px;font-weight:600;white-space:nowrap;flex-shrink:0}.chat-new svg{width:15px;height:15px}.chat-new:hover:not(:disabled){border-color:#b8cbf5;background:#f7faff}.chat-new:disabled{opacity:.5;cursor:not-allowed}
.chat-system{align-self:stretch;max-width:100%;border:1px solid var(--border);border-left:3px solid var(--warning);background:var(--warning-tint);border-radius:12px;padding:12px 16px;color:var(--text)}.chat-system .chat-message-author{display:flex;align-items:center;gap:6px;color:var(--warning)}.chat-system .chat-message-author svg{width:16px;height:16px;flex:0 0 16px}.chat-system .chat-message-text{font-size:14px;line-height:1.55}.chat-system-detail{margin-top:6px;font-size:12px;line-height:1.5;color:var(--text-muted);white-space:pre-wrap;overflow-wrap:anywhere}.chat-system-info{border-left-color:var(--primary);background:var(--bg-sunken)}.chat-system-info .chat-message-author{color:var(--text-muted)}
.chat-transcript{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px clamp(20px,5vw,72px);display:flex;flex-direction:column;gap:20px}.chat-message{max-width:88%;min-width:0;flex-shrink:0}.chat-user{align-self:flex-end;background:#ecf2ff;border:1px solid #e1e8fc;border-radius:18px 18px 4px 18px;padding:14px 18px}.chat-assistant{align-self:flex-start;padding:4px 0}.chat-message-author{display:block;font-size:12px;font-weight:600;color:#607298;margin-bottom:6px}.chat-message-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--ui-body-size);line-height:1.55}.chat-tool{align-self:flex-start;border:1px solid #e3e8f1;border-radius:12px;padding:8px 14px;background:#fff;width:100%}.chat-tool summary{cursor:pointer;display:flex;gap:10px;align-items:center;min-height:30px}.chat-tool .badge{margin-left:auto}.chat-tool pre{max-height:180px}.chat-approvals{padding:0 20px 12px;max-height:65%;overflow:auto}.chat-approvals .card{padding:12px 14px}.chat-approvals .card h3{font-size:14px}.chat-approvals .card .banner{padding:7px 10px;font-size:12px;line-height:1.4}.chat-approvals .card dl{max-height:70px;overflow:auto;margin:8px 0;gap:4px 12px;font-size:12px}.chat-approvals .card .actions{margin-top:8px}.chat-approvals .card button{min-height:36px;padding:6px 12px;font-size:13px}.chat-approvals:has(>.empty){display:none}
@media(max-height:800px){.chat-welcome{padding:16px}.chat-glow{width:84px;height:84px;min-height:84px;margin-bottom:12px}.chat-glow svg{width:40px;height:40px}.chat-welcome h1{font-size:26px}.chat-intro{font-size:16px;margin-bottom:22px}.chat-starter{min-height:52px}.chat-workspace{gap:10px}.chat-stage{margin-bottom:-10px}}
@media(max-width:760px){.chat-active main.content{padding:12px;overflow:auto}.chat-active #page{height:auto;min-height:100%}.chat-workspace{height:auto;min-height:100%}.chat-stage{flex:1 0 auto;min-height:350px}.chat-welcome{flex:1 0 auto;min-height:350px}.chat-transcript{max-height:60dvh}.chat-intro{font-size:14px;margin-bottom:16px}.chat-welcome{padding:12px}.chat-glow{width:72px;height:72px;min-height:72px}.chat-starters{gap:8px}.chat-starter{font-size:12px;padding:10px;gap:8px}.chat-starter svg{width:18px}.chat-selectors{padding:8px;gap:8px;flex-wrap:wrap}.chat-thread{order:3;width:100%;justify-content:space-between}.chat-dropdown{max-width:100%}.chat-selectors>.chat-dropdown{width:calc(50% - 4px)}.chat-selector{min-width:0;width:100%;padding:8px;font-size:12px;gap:6px}.chat-compose{padding:12px}.chat-shortcut{display:none}.chat-agents{gap:6px;padding:2px;min-height:38px}.chat-agent-label{font-size:11px}.chat-agent-pills{gap:5px;flex-wrap:nowrap;justify-content:flex-start;overflow-x:auto}.chat-agent-pill{flex-shrink:0;height:28px;font-size:12px}.chat-message{max-width:96%}}
/* ═══════════════════════════════════════════════════════════════
   CHAT INPUT — PIXEL-PERFECT PER SPEC (светлая тема, Notion/Gemini стиль)
   ═══════════════════════════════════════════════════════════════ */

/* ── Main card ── */
.chat-compose{
  background:#FFFFFF;
  border:1px solid #E5E7EB;
  border-radius:16px;
  padding:16px 20px 12px 20px;
  box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
  transition:border-color .2s ease,box-shadow .2s ease}
.chat-compose:focus-within{border-color:#D1D5DB;box-shadow:0 2px 8px rgba(0,0,0,.08)}

/* ── Textarea ── */
.chat-compose textarea{
  display:block;width:100%;
  border:0;outline:0;resize:none;background:transparent;
  font-family:inherit;font-size:16px;font-weight:400;
  color:#111827;line-height:1.5;
  min-height:24px;height:24px;max-height:200px;overflow-y:auto;
  padding:0;margin-bottom:12px}
.chat-compose textarea::placeholder{color:#9CA3AF;font-weight:400}
.chat-compose textarea:hover,.chat-compose textarea:focus,.chat-compose textarea:focus-visible{outline:none;box-shadow:none;border:0}

/* ── Toolbar ── */
.chat-compose-actions{display:flex;align-items:center;justify-content:space-between;gap:4px}
.chat-compose-left{display:flex;align-items:center;gap:4px}
.chat-send-actions{display:flex;align-items:center;gap:8px}

/* ── Plus button [+] 32×32 ── */
.chat-plus-btn{
  display:grid;place-items:center;
  width:32px;min-width:32px;height:32px;min-height:32px;
  border:0;border-radius:8px;background:transparent;
  color:#6B7280;cursor:pointer;padding:0;flex-shrink:0;
  transition:background .15s,color .15s}
.chat-plus-btn svg{width:20px;height:20px;stroke-width:1.75}
.chat-plus-btn:hover{background:#F3F4F6;color:#374151}
.chat-plus-btn:focus-visible{outline:2px solid #374151;outline-offset:2px}

/* ── "Review for me" text button ── */
.chat-review-btn{
  border:0;border-radius:8px;background:transparent;cursor:pointer;
  font-family:inherit;font-size:14px;font-weight:500;color:#6B7280;
  padding:6px 12px;transition:background .15s,color .15s;white-space:nowrap}
.chat-review-btn:hover{background:#F3F4F6;color:#374151}

/* ── "Auto ↓" model chip (inline, right of spacer) ── */
.chat-model-chip{
  display:inline-flex;align-items:center;gap:4px;
  border:0;border-radius:8px;background:transparent;cursor:pointer;
  font-family:inherit;font-size:14px;font-weight:500;color:#374151;
  padding:6px 12px;transition:background .15s;white-space:nowrap}
.chat-model-chip:hover{background:#F3F4F6}
.chat-model-chip svg{flex-shrink:0;color:#9CA3AF;width:12px;height:12px}
.chat-model-chip span{max-width:120px;overflow:hidden;text-overflow:ellipsis}

/* ── Send button: серый → тёмный (#111827) когда есть текст ── */
.chat-send{
  width:32px;height:32px;min-width:32px;min-height:32px;max-width:32px;
  flex:0 0 32px;aspect-ratio:1;padding:0;border:0;border-radius:50%;
  background:#E5E7EB;color:#9CA3AF;
  display:grid;place-items:center;
  transition:background .2s ease,color .2s ease;
  cursor:default}
.chat-send svg{width:16px;height:16px;stroke-width:2.5}
.chat-send.chat-send-ready{background:#111827;color:#FFFFFF;cursor:pointer}
.chat-send.chat-send-ready:hover{background:#000000}
.chat-send[data-running=true]{background:#111827;color:#FFFFFF;cursor:pointer}
.chat-send[data-running=true]:hover{background:#000000}

/* ── Shortcut hint — hidden (E2E stays) ── */
.chat-shortcut{display:none}

/* ── Plus popover — позиционируется JS ── */
.chat-plus-pop{
  width:230px;padding:5px;
  border:1px solid #E5E7EB;border-radius:14px;
  box-shadow:0 8px 28px rgba(13,26,50,.08),0 2px 6px rgba(13,26,50,.06);
  background:#FFFFFF;color:#111827}
.chat-plus-row{
  display:flex;align-items:center;gap:10px;
  padding:8px 10px;border-radius:8px;cursor:pointer;
  border:0;background:transparent;width:100%;
  font-family:inherit;font-size:13.5px;color:#374151;text-align:left;
  transition:background .12s}
.chat-plus-row:hover{background:#F9FAFB}
.chat-plus-row svg{width:16px;height:16px;color:#6B7280;flex-shrink:0}
.chat-plus-row:hover svg{color:#374151}
.chat-plus-beta{margin-left:auto;font-size:10px;padding:1px 5px;border-radius:4px;background:#DCFCE7;color:#15803D;font-weight:600;flex-shrink:0}
.chat-plus-count{margin-left:auto;font-size:12px;color:#9CA3AF;flex-shrink:0}
.chat-plus-browser-row{cursor:default}

/* ── Browser toggle pill 32×18 ── */
.chat-browser-toggle-pill{
  width:32px;height:18px;min-width:32px;border-radius:9px;
  background:#D1D5DB;border:0;padding:0;cursor:pointer;
  position:relative;transition:background .15s;margin-left:auto;flex-shrink:0}
.chat-browser-toggle-pill .chat-toggle-thumb{
  position:absolute;top:2px;left:2px;
  width:14px;height:14px;border-radius:50%;
  background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,.2);
  transition:left .12s}
.chat-browser-toggle-pill.on{background:#1A6BFF}
.chat-browser-toggle-pill.on .chat-toggle-thumb{left:16px}

/* ══════════════════════════════════════════════
   STATUS BAR — плоские провайдеры ниже compose
   ══════════════════════════════════════════════ */
.chat-agents{
  position:relative;display:flex;align-items:center;
  justify-content:flex-start;padding:8px 16px 2px;
  flex-wrap:wrap;min-height:36px;gap:0}
.chat-agent-label{display:none}
.chat-agent-pills{display:flex;align-items:center;gap:0;flex-wrap:wrap;padding:0}

/* Flat pill item */
.chat-agent-pill{
  display:inline-flex;align-items:center;gap:6px;
  border:0;background:transparent;
  height:28px;min-height:0;padding:0 8px;
  min-width:0;font-family:inherit;font-size:14px;font-weight:500;
  color:#374151;cursor:pointer;white-space:nowrap;
  border-radius:0;transition:color .12s}
.chat-agent-pill:hover{color:#111827}
.chat-agent-pill[aria-pressed=true]{color:#111827}
.chat-agent-pill svg{width:16px;height:16px;flex-shrink:0;stroke-width:1.5}
.chat-agent-pill img{width:16px;height:16px;object-fit:contain;flex-shrink:0;border-radius:4px}

/* Letter avatar for custom providers (like [R]) */
.chat-pill-letter{
  display:grid;place-items:center;
  width:20px;height:20px;min-width:20px;
  border:1.5px solid #D1D5DB;border-radius:5px;
  font-size:11px;font-weight:700;color:#374151;
  flex-shrink:0;background:#FFFFFF;line-height:1}

.chat-pill-name{font-size:14px;font-weight:500;color:#374151}
.chat-pill-model{display:none}

/* Green online dot 8×8 */
.chat-online{width:8px;height:8px;min-width:8px;border-radius:50%;background:#22C55E;flex-shrink:0}

/* Vertical divider between providers — 1px line, 16px tall */
.chat-pill-sep{
  display:inline-block;width:1px;height:16px;
  background:#E5E7EB;margin:0 8px;flex-shrink:0}

/* Model popover (drop-up) */
.chat-model-pop{
  position:absolute;top:auto;bottom:calc(100% + 8px);left:0;z-index:30;
  max-height:260px;overflow-y:auto;min-width:200px;padding:5px;
  border:1px solid #E5E7EB;border-radius:12px;
  box-shadow:0 8px 24px rgba(13,26,50,.1);background:#FFFFFF}
.chat-model-pop .chat-menu-item{padding:7px 10px;font-size:13px;border-radius:7px;color:#374151}
.chat-model-pop-disconnect{
  width:100%;text-align:left;border:0;border-top:1px solid #F3F4F6;
  border-radius:0 0 7px 7px;margin-top:4px;padding:7px 10px;
  background:transparent;font-family:inherit;font-size:13px;color:#EF4444;cursor:pointer}
.chat-model-pop-disconnect:hover{background:#FFF5F5}

/* ── Copy button: clipboard icon, 22×22 ── */
.chat-message-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.chat-copy-btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;min-width:22px;
  border:0;background:transparent;border-radius:5px;
  color:#C8D0DE;cursor:pointer;
  opacity:0;transition:opacity .12s,background .12s,color .12s;
  padding:0;margin-left:auto}
.chat-message:hover .chat-copy-btn{opacity:1}
.chat-copy-btn:hover{background:#EFF3FF;color:#1A6BFF}
.chat-copy-btn.copied{color:#22C55E;opacity:1}
.chat-user .chat-copy-btn{color:#A8BBD8}
.chat-user .chat-copy-btn:hover{background:#DCE8FF;color:#1A4AB8}
.chat-copy-btn svg{pointer-events:none}

/* ── Thinking indicator ── */
.chat-thinking-indicator{display:flex;align-items:center;padding:4px 0}
.chat-thinking-text{font-size:13.5px;color:#9CA3AF;animation:chat-pulse 1.3s ease-in-out infinite}
@keyframes chat-pulse{0%,100%{opacity:.3}50%{opacity:1}}
`;
