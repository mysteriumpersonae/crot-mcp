/** Static trusted copy only. Never interpolate callback/query/provider payloads. */
import { mascotData } from "../ui/mascot.js";
export function callbackPage(success: boolean, russian: boolean, nonce: string, returnUrl?: string): string {
  const title = russian
    ? success
      ? "Вы вошли в CROT"
      : "Не удалось завершить вход"
    : success
      ? "You’re signed in to CROT"
      : "Sign-in wasn’t completed";
  const description = russian
    ? success
      ? "Вернитесь в приложение — ваш аккаунт уже подтверждён."
      : "Вернитесь в приложение, чтобы посмотреть причину и повторить попытку."
    : success
      ? "Return to the application — your account is verified and ready."
      : "Return to the application to see the details and try again.";
  return `<!doctype html><html lang="${russian ? "ru" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · CROT</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#f8fafc;color:#172033;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}main{width:100%;max-width:460px;padding:40px 32px;text-align:center;background:white;border:1px solid #d6e0ec;border-radius:16px;box-shadow:0 8px 32px #17203308}img{width:88px;height:72px}.brand{margin:8px 0 24px;font-weight:700;letter-spacing:1px;font-size:14px;color:#536984}.status{display:inline-block;padding:5px 12px;border-radius:6px;background:${success ? "#eaf6ef" : "#fff4e5"};color:${success ? "#17633b" : "#805008"};font-size:14px}h1{font-size:26px;line-height:1.25;letter-spacing:-.5px;margin:20px 0 12px}p{margin:0 0 24px;color:#536984}button{width:100%;min-height:48px;padding:12px 16px;border:0;border-radius:10px;background:#0867e8;color:#fff;font-family:inherit;font-size:16px;line-height:1.5;font-weight:600;cursor:pointer}button:hover{background:#075acb}button:focus-visible{outline:2px solid #2563eb;outline-offset:3px}form{margin:0}button:disabled{opacity:.65;cursor:default}.hint{font-size:14px;line-height:1.5;margin:16px 0 0;color:#617089}@media(max-width:480px){main{padding:32px 24px}}
</style></head><body><main aria-labelledby="title"><img src="${mascotData()}" alt=""><div class="brand">CROT CONTROL CENTER</div><span class="status">${russian ? (success ? "Аккаунт подтверждён" : "Вход не завершён") : success ? "Account verified" : "Please try again"}</span><h1 id="title">${title}</h1><p>${description}</p><form ${returnUrl ? `action="${returnUrl}" method="post"` : ""}><button id="continue" type="submit" ${returnUrl ? "" : "disabled"}>${russian ? "Продолжить в CROT" : "Continue in CROT"}</button><p id="return-hint" class="hint" role="status">${russian ? "Кнопка вернёт вас в уже открытое окно приложения. Если система не переключила окно, выберите CROT на панели задач или в Dock." : "Continue to your existing CROT window. If your system does not switch windows, select CROT in your taskbar or Dock."}</p></main><script nonce="${nonce}">history.replaceState(null,'','/oauth/callback');const target=${JSON.stringify(returnUrl ?? null)};document.getElementById('continue').onclick=async()=>{const button=document.getElementById('continue');button.disabled=true;try{const r=await fetch(target,{method:'POST',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'});if(!r.ok)throw Error();document.getElementById('return-hint').textContent=${JSON.stringify(russian ? "Окно CROT открыто. Если система не переключила окно, выберите CROT на панели задач или в Dock." : "CROT is open. If your system did not switch windows, select CROT in your taskbar or Dock.")};}catch{document.getElementById('return-hint').textContent=${JSON.stringify(russian ? "Ссылка возврата истекла или приложение недоступно. Выберите CROT на панели задач или в Dock." : "The return link expired or the app is unavailable. Select CROT in your taskbar or Dock.")};}};</script></body></html>`;
}
