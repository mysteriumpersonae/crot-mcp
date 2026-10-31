import { mascotData, wordmarkData } from "../ui/mascot.js";
export const LOGIN_HTML = `
<section id="auth-gate" class="welcome-screen" aria-labelledby="auth-title" data-no-i18n>
<header id="auth-language" class="welcome-language"></header>
<div class="auth-card"><img class="auth-mole" src="${mascotData()}" alt=""><h1 id="auth-title" class="sr-only">CROT Control Center</h1><img class="auth-wordmark" src="${wordmarkData()}" alt="CROT Control Center">
<p class="description" id="auth-description">Безопасный контроль локальных и удалённых агентов.</p>
<form id="auth-form" novalidate>
<label class="field" id="login-field"><span id="login-label">Логин</span><div class="auth-input"><span class="auth-input-icon" aria-hidden="true">@</span><input id="auth-username" autocomplete="username" minlength="3" maxlength="32" required aria-describedby="auth-feedback"></div></label>
<label class="field" id="email-field"><span id="email-label">Рабочая почта</span><div class="auth-input"><span class="auth-input-icon" aria-hidden="true">✉</span><input id="work-email" type="email" autocomplete="email" placeholder="name@company.com" maxlength="254" required aria-describedby="auth-feedback"></div></label>
<label class="field" id="password-field"><span id="password-label">Пароль</span><div class="auth-input"><input id="auth-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required aria-describedby="auth-feedback"><button id="password-toggle" type="button" aria-label="Показать пароль" aria-pressed="false"></button></div></label>
<button class="primary auth-submit" id="auth-submit" type="submit">Создать аккаунт →</button></form>
<form id="otp-form" hidden novalidate><h2 id="otp-title">Подтвердите почту</h2><p id="otp-description"></p><label class="field"><span id="otp-label">Код из письма</span><input id="auth-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-describedby="otp-description auth-feedback" placeholder="000000"></label><button class="primary auth-submit" id="otp-submit" type="submit">Подтвердить</button><button id="otp-resend" class="link" type="button">Отправить код повторно</button></form>
<p class="account-line"><span id="account-prompt">Уже есть аккаунт?</span><button id="login" class="link" type="button">Войти</button></p>
<div class="divider" id="auth-divider"><span id="auth-or">или</span></div>
<button id="google" class="oauth" type="button"><span class="google-logo" aria-hidden="true">G</span><span id="google-label">Продолжить с Google</span></button>
<button id="github" class="oauth" type="button"><span class="provider-icon" data-brand="GitHub" aria-hidden="true"></span><span id="github-label">Продолжить с GitHub</span></button>
<button id="auth-back" class="link" type="button" hidden>Назад ко входу</button>
<button id="provider-open" hidden class="link" type="button">Настройка провайдеров</button>
<p id="auth-feedback" class="auth-feedback" role="alert" aria-live="polite"></p>
</div><dialog id="provider-bootstrap" aria-labelledby="provider-title" aria-describedby="provider-note"><form id="provider-form" autocomplete="off"><h2 id="provider-title"></h2><p id="provider-note"></p><div id="provider-fields"><label class="field"><span>Google Client ID</span><input id="provider-googleId" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label><label class="field"><span>Google Client Secret</span><input id="provider-googleSecret" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label><label class="field"><span>GitHub Client ID</span><input id="provider-githubId" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label><label class="field"><span>GitHub Client Secret</span><input id="provider-githubSecret" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label><label class="field"><span>Gmail Address (SMTP_USER)</span><input id="provider-gmail" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label><label class="field"><span>Gmail App Password (SMTP_PASS)</span><input id="provider-appPassword" type="password" autocomplete="off" required maxlength="512" spellcheck="false" autocapitalize="off"></label></div><p id="provider-feedback" role="alert" aria-live="polite"></p><button id="provider-save" class="primary auth-submit" type="submit"></button><button id="provider-close" class="link" type="button"></button></form></dialog></section>`;
/** Scoped to Screen 01; never overrides Plans or workspace tokens/geometry. */
export const LOGIN_CSS = String.raw`
#auth-gate{--text:#0f172a;--muted:#61748f;--border:#d6e0ec;--surface:#fff;--primary:#1479ff;color-scheme:light;background:#f8fafc;color:var(--text);font-family:"Inter Variable",Inter,sans-serif;overflow:auto;padding:72px 24px 32px;place-items:start center}
#auth-gate #provider-bootstrap{width:560px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:hidden;background:#fff;color:#0f172a;border:1px solid #d6e0ec;border-radius:12px;padding:24px;font-family:inherit;box-shadow:0 8px 32px #0f172a24}
#auth-gate #provider-form{display:flex;flex-direction:column;max-height:calc(100dvh - 80px)}
#auth-gate #provider-form>*{flex-shrink:0}
#auth-gate #provider-form #provider-fields{flex-shrink:1;overflow-y:auto;min-height:100px;padding:8px;margin:-8px 0 12px;border-bottom:1px solid #d6e0ec;overscroll-behavior:contain}
#auth-gate #provider-bootstrap::backdrop{background:#0f172a70}
#auth-gate #provider-title{font-size:22px;line-height:30px;margin:0 0 12px}
#auth-gate #provider-note{font-size:14px;line-height:20px;color:#536984;margin:0 0 20px}
#auth-gate #provider-feedback{font-size:14px;line-height:20px;color:#b42318;overflow-wrap:anywhere;margin:0 0 8px}
#auth-gate #provider-save{height:auto;min-height:48px;padding:12px;white-space:normal}
#auth-gate #provider-close,#auth-gate #provider-open{min-height:44px;margin-top:8px}
#auth-gate .auth-card{width:556px;max-width:100%;transform:none;margin:auto;flex-shrink:0;padding:0;text-align:center}
#auth-gate .auth-mole{width:140px;height:108px;object-fit:contain;margin-bottom:12px}
#auth-gate .auth-wordmark{width:210px;height:86px;filter:none;object-fit:contain}
#auth-gate .description{font-size:18px;line-height:26px;color:#61748f;white-space:normal;margin:12px -48px 32px;text-wrap:balance}
#auth-gate form{width:100%;margin:0}
#auth-gate .field{display:flex;flex-direction:column;text-align:left;gap:8px;margin:0 0 12px;font-size:18px;line-height:24px;font-weight:500}
#auth-gate .auth-input{position:relative;display:flex;align-items:center}
#auth-gate input{width:100%;height:56px;min-height:56px;background:#fff;color:#0f172a;border:1px solid #ccd9e9;border-radius:12px;padding:12px 16px;font-size:18px;line-height:24px;box-shadow:0 1px 2px #0f172a05;font-family:inherit;transition:none}
#auth-gate input::placeholder{color:#61748f;opacity:1}
#auth-gate .auth-input-icon{position:absolute;left:16px;display:grid;place-items:center;color:#536984;width:24px;height:24px;font-size:22px}
#auth-gate .auth-input-icon+input{padding-left:56px}
#auth-gate #auth-password{padding-right:60px}
#auth-gate #password-toggle{position:absolute;right:4px;width:48px;height:48px;min-height:48px;padding:12px;border:0;background:transparent;color:#536984}
#auth-gate button{font-family:inherit;border-radius:12px;transition:opacity 200ms cubic-bezier(.22,1,.36,1);color:#0f172a}
#auth-gate button:focus-visible,#auth-gate input:focus-visible,#auth-gate select:focus-visible{outline:3px solid #1479ff;outline-offset:3px;box-shadow:none}
#auth-gate .auth-submit{height:64px;min-height:64px;width:100%;background:#0867e8;color:#fff;border:1px solid #0867e8;justify-content:center;font-size:18px;line-height:24px;font-weight:500;margin:0;box-shadow:0 3px 8px #1479ff1a}
#auth-gate .auth-submit:hover:not(:disabled){background:#0867e8;border-color:#0867e8}
#auth-gate .account-line{display:flex;justify-content:center;flex-wrap:wrap;gap:4px;margin:16px 0 24px;font-size:16px;line-height:24px;color:#61748f}
#auth-gate .link{border:0;background:transparent;color:#0668ee;padding:0;min-height:24px;font-size:inherit;text-decoration:underline;box-shadow:none}
#auth-gate .divider{width:100%;margin:0 0 20px;gap:16px;color:#61748f;font-size:16px;line-height:24px}
#auth-gate .divider:before,#auth-gate .divider:after{background:#d6e0ec}
#auth-gate .oauth{display:flex;align-items:center;justify-content:center;gap:16px;width:100%;height:64px;min-height:64px;background:#fff;border:1px solid #d6e0ec;border-radius:12px;margin:0 0 12px;padding:12px;font-size:18px;line-height:24px;font-weight:500;box-shadow:0 1px 3px #0f172a08}
#auth-gate .oauth:hover:not(:disabled){background:#f0f5fc}
#auth-gate .vendor-mark{width:28px;height:28px;padding:0}
#auth-gate .auth-feedback{color:#b42318;font-size:14px;line-height:20px;min-height:20px;margin:8px 0 0;max-width:100%;overflow-wrap:anywhere}
#auth-gate .auth-feedback[data-kind=info]{color:#536984}
#auth-gate [aria-invalid=true]{border-color:#b42318}
#auth-gate .welcome-language{top:32px;right:32px;background:#fff;border:1px solid #d6e0ec;border-radius:12px;height:44px;color:#0f172a;gap:8px;padding-left:12px}
#auth-gate .welcome-language svg{color:#1479ff;width:20px;height:20px}
#auth-gate .welcome-language select{font:16px/24px "Inter Variable",Inter,sans-serif;color:#0f172a;border:0;background:#fff;min-height:40px;padding:8px;border-radius:12px}
#auth-gate #auth-code{font-size:30px;letter-spacing:12px;text-align:center;padding-left:28px}
#auth-gate #otp-title{font-size:24px;line-height:32px;margin:0 0 8px;color:#0f172a}
#auth-gate #otp-description{font-size:16px;line-height:24px;color:#61748f}
#auth-gate #otp-resend{margin:20px 0 0;min-height:44px;font-size:16px}
#auth-gate #auth-back{margin:16px 0 0;min-height:44px;font-size:16px}
@media(max-height:1100px){#auth-gate{padding-top:64px}#auth-gate .auth-mole{width:112px;height:88px;margin-bottom:8px}#auth-gate .auth-wordmark{width:172px;height:70px}#auth-gate .description{margin:8px -24px 24px;font-size:16px;line-height:24px}#auth-gate .field{font-size:16px;gap:4px;margin-bottom:12px}#auth-gate input{height:44px;min-height:44px;font-size:16px}#auth-gate .auth-submit,#auth-gate .oauth{height:48px;min-height:48px;font-size:16px}#auth-gate .account-line{margin:12px 0 16px}#auth-gate .divider{margin-bottom:16px}}
@media(max-height:850px) and (min-width:601px){#auth-gate{padding:24px}#auth-gate .auth-mole{width:96px;height:72px;margin-bottom:4px}#auth-gate .auth-wordmark{width:150px;height:60px}#auth-gate .description{margin:4px -24px 16px}#auth-gate .field{margin-bottom:10px}#auth-gate .account-line{margin:8px 0 12px}#auth-gate .divider{margin-bottom:12px}#auth-gate .oauth{margin-bottom:8px}#auth-gate #provider-open{margin-top:4px}}
@media(max-width:600px){#auth-gate{padding:88px 24px 24px}#auth-gate .description{margin-left:0;margin-right:0}#auth-gate .welcome-language{right:24px;top:24px}#auth-gate .auth-card{margin:auto 0}#auth-gate .auth-mole{width:100px;height:80px}#auth-gate .auth-wordmark{width:156px;height:64px}}
/* A single quiet focus treatment, no stacked outline + border rings. */
#auth-gate input{transition:border-color .15s,box-shadow .15s}
#auth-gate input:hover:not(:disabled){border-color:#91a8c4}
#auth-gate input:focus,#auth-gate input:focus-visible{outline:none;border-color:#2563eb;box-shadow:0 0 0 2px #2563eb18}
#auth-gate button:focus-visible,#auth-gate select:focus-visible{outline:2px solid #2563eb;outline-offset:2px;box-shadow:none}
#auth-gate .welcome-language{padding:0 0 0 12px;gap:8px;overflow:hidden}
#auth-gate .welcome-language select{appearance:none;width:64px;padding:10px 28px 10px 4px;border-radius:0;background:transparent;cursor:pointer}
#auth-gate .welcome-language:after{content:"";position:absolute;right:14px;top:17px;width:6px;height:6px;border-right:1.5px solid #536984;border-bottom:1.5px solid #536984;transform:rotate(45deg);pointer-events:none}
#auth-gate[data-auth-step=verify] .auth-card{width:440px}
#auth-gate #otp-form{text-align:center;margin-top:8px}
#auth-gate #otp-title{margin-bottom:12px}
#auth-gate #otp-description{margin:0 auto 24px;max-width:360px;text-wrap:balance}
#auth-gate #otp-form .field{gap:8px;margin-bottom:16px}
#auth-gate #auth-code{height:56px;min-height:56px;font-size:26px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:8px;padding:12px 12px 12px 20px}
#auth-gate #auth-code::placeholder{color:#91a0b3}
#auth-gate #otp-resend{display:block;margin:12px auto 0;text-decoration:none}
#auth-gate #otp-resend:disabled{opacity:1;color:#61748f}
#auth-gate #auth-back{margin:16px 0 0;text-decoration:none}
#auth-gate .auth-feedback:empty{min-height:0;margin:0}
@media(prefers-reduced-motion:reduce){#auth-gate *{transition:none!important;animation:none!important}}
`;
