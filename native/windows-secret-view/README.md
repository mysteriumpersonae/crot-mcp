# AD-55 historical experiment — retired by AD-57

The owner restored the prohibition on third-party filesystem drivers. The
active pinned Dokan SDK/MSI download, installer, compiler and unused AD-55
helper implementations have been removed. Their paths retain comment-only
historical markers; no executable source, SDK include or DLL import remains. Pismo was never installed or bundled.
No product manifest includes either runtime. The historical decoder/evidence
remain so prior failures are not erased or relabeled as success.

The original source is retained in Git history at
`da34dce8c8bbc5e730bd9b64271da7db1fe79ea6` and earlier. This directory no longer
contains a runnable driver-dependent candidate.

The old builder name is a fail-closed compatibility tombstone: it refuses on
all hosts before downloading/installing/executing anything. The mandatory
positive Windows acceptance test remains unqualified/red; removal of an
abandoned dependency is not a replacement backend or a passing native gate.

[Bounded native evidence](../../docs/evidence/windows-l1-ad55/da34dce8-component-summary.json)
records both actual AppContainer/LPAC relative data opens failing before any
create callback. These rejected data/control topologies do not establish a
usable filesystem barrier. AD-56 separately records unresolved runtime
integration rights; a free SDK does not permit runtime redistribution.

AD-57's native hardlink proposal is under security review. Same-inode metadata,
atomic replacement, stale public aliases and finite stubs/watchers have real
filesystem counterexamples. The new regression experiments exercise those
properties, not confined L1 admission. No full Stage A Pass is claimed.
