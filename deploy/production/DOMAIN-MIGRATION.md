# Official production domain

The only official production domain is `crot.network`; the MCP/Relay endpoint
is `https://mcp.crot.network` and the pinned issuer is `https://auth.crot.network`.
Use `identity.example.json` and `relay.example.json` as the matched production
configuration pair. Temporary alternative-domain profiles have been removed
following the owner correction recorded in AD-60.

These files do not provision DNS, certificates or identity applications. Replace
the placeholder pairing client ID before release. Issuer/audience verification
is not widened and there is no alternate production-domain alias. A deployed
older relay host requires an explicit operator-managed endpoint migration and
re-pairing; do not redirect or silently mix pinned configurations.
