# AD-55: isolated Windows secret-view candidate

Research only. Never imported or registered by production. Reuses CROT's
historical AD-27/28 component as a **new composite experiment**, without
changing the old failed gates or their evidence. The exact effective
zero-capability AppContainer and LPAC children must positively read/write a
live projected `public.txt`, while raw control-device zero/read/metadata opens
remain denied before and after data access. File SD grants are not raw-device
grants. No IOCTL is sent to a control device by the child.

The fixture downloads the pinned official Dokan 2.3.1 SDK/MSI on a disposable
GitHub-hosted Windows runner only. It verifies SHA256, installer Authenticode,
installed driver Microsoft hardware-publisher signature and kernel signing
policy, version, and actual dynamic `dokan2.dll` import. It never builds/signs
a kernel driver or changes test-signing/Secure Boot. Unavailable verification
is a failure, not a skipped qualification or an alternate launcher.

Dokan is LGPL-3.0, dynamically linked; its samples are MIT. This folder contains
CROT-owned controller/probe source from repository history, not embedded Dokan
implementation. The [pinned license](https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/license.lgpl.txt)
and [upstream source](https://github.com/dokan-dev/dokany/tree/v2.3.1.1000) must
be supplied/referenced with notices and applicable LGPL replacement/relinking
and installation-information obligations before any distribution. No production
package or license-compliance completion is claimed here.

Even a successful experiment is NOT the complete future-secret barrier, owner
exceptions/revocation, tool compatibility, crash recovery or Stage A acceptance.
No production fallback/availability policy is changed by this fixture.


The absolute-path candidate at `cc244740` failed both Windows jobs before any
create callback. The next isolated follow-up explicitly inherits **one scoped
data directory file handle** (HANDLE_LIST), not the disk/control device. Only
the controller's exact PID/token can pre-open the fixed root with read/traverse
rights. Child creates still require the actual AppContainer SID/token/owned Job.
Live data is attempted with relative NtCreateFile through that capability; raw
controls are probed unchanged. It is not proof of general absolute Win32/Node/
PowerShell compatibility or a production backend. See AD-55 follow-up decision.
