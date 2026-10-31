# Screen 01: secure local login and provider setup

Only Screen 01 is revised. Accounts are local per OS user, not a shared cloud
identity, a remote-access entitlement, or a paid subscription.

## Start and configure without files

Use Node 20.19+ / 22 and the Electron prerequisites in INSTALL.md:

```
npm ci
npm run build
npm start
```

On first launch **Authentication provider setup (Admin Bootstrap)** opens on Screen 01.
Enter the Google Desktop Client ID/Secret, GitHub OAuth App Client ID/Secret,
Gmail address and 16-letter Gmail App Password. All fields are masked. Grouping
spaces in the Gmail App Password are accepted. Click **Save to secure store and verify**.

Gmail defaults to `smtp.gmail.com:465` with TLS 1.2+ and certificate validation.
The Gmail address is both SMTP_USER and SMTP_FROM. The app verifies connection and
SMTP authentication before replacing the OS record. This does not send an email yet.
OAuth validation here checks format only; Google/GitHub buttons perform real consent,
token exchange and verified-profile lookup. Saving configuration never admits to Plans.

No `.env` or environment credentials are read by this desktop path. There is no
terminal OTP, plaintext-file, encrypted-file, kernel-memory or basic_text fallback.
Missing/locked OS storage is reported. An existing verified local account can still
use password login without SMTP/OAuth access. Close the modal to sign in; reopen
with **Provider settings**. To replace keys, re-enter all six fields. Existing
credentials are never returned to the renderer.

## System storage and local trust boundary

The native `@napi-rs/keyring` binding uses service `CROT.DesktopAuth.Providers.v1`,
account `local-owner`, with Windows Credential Manager, macOS Keychain or Linux
Secret Service. Linux is explicitly pinned to Secret Service; a running unlocked
GNOME Keyring/KWallet/compatible service and D-Bus session are required.

This is a local OS-owner bootstrap, not a remote administrator role. Secrets exist
transiently in the password fields, IPC and main memory during submission, then fields
are cleared. No values are logged, added to Git, put in URLs/browser storage, returned
by the status endpoint, or copied to tool subprocess environments. Memory dumps and a
compromised owner account are outside this protection. Respect OS keychain prompts.

Google **Desktop app** is correct for the current installed-app flow: system browser,
state, S256 PKCE and `http://127.0.0.1:43821/oauth/callback`. Configure consent-screen
users if the OAuth app is in testing. No Web application client is needed for this
local callback and token exchange. GitHub requires an **OAuth App** with the same
callback (not a GitHub App). Loopback port 43821 is fixed.

No public server broker is implemented, so there is no web Authorized redirect URI
to invent. A future confidential web broker requires its own actual HTTPS callback,
Web application client and server-kept credentials. Do not embed/distribute client
secrets in a public desktop package; these are local operator credentials.

## Manual acceptance

1. First launch with no OS record: bootstrap appears, no manual files needed.
2. Correct Gmail credentials: SMTP verification succeeds and keys persist in the OS
   vault. Relaunch: no setup prompt if that record can be read.
3. Wrong App Password or locked/missing store: safe error; no file fallback, no admission.
4. Empty form, short login/password and malformed email stay on Screen 01.
5. Register unique username/email/password. Account is pending until correct OTP.
   A real SMTP email carries the one-use six-digit code, valid 10 minutes. Wrong or
   expired codes fail; five attempts, resend cooldown 60 seconds. Correct code creates
   a main-memory session before Plans opens.
6. Relaunch and log in with username or email. Wrong password fails; unverified accounts
   require a fresh code. Passwords/codes are salted scrypt hashes, never plaintext.
7. Google/GitHub buttons open the system browser and admit only after a successful
   callback/token/profile flow. No silent linking to an existing account by email.
8. RU/EN, eye toggle, keyboard/modal focus and narrow-window scrolling work.

Accounts: `<CROT state directory>/desktop-auth/accounts.json`. Session: main memory,
12-hour maximum, lost on exit. Provider access tokens are discarded after profile lookup.
POSIX private files are checked; account-DB Windows inherited ACL limitations remain.
This does not change Core/Relay permissions or grant remote/paid access.

Tests use synthetic credentials. Live owner Gmail delivery and provider consent must
be tested locally after entering keys. Never paste live credentials into chat. A
compiled source tree is not a signed autonomous Windows installer.
