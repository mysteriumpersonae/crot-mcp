# Opt-in networking domain deployment

The Stage B target is `crot.networking`, MCP endpoint `mcp.crot.networking`.
Use `relay.networking.example.json` and `identity.networking.example.json`
as one matched configuration pair after DNS/TLS and the identity provider are
provisioned by the operator. These files do not provision DNS, certificates or
identity applications. Replace the placeholder pairing client ID before release.

Existing `*.example.json` profiles and pinned staging fixtures retain
`crot.network` for compatibility. There is no implicit issuer alias, redirect,
or relaxation of audience/host verification. Keep the old host operational for
existing paired clients; switching a pinned identity profile requires deliberate
re-pairing and matching backend configuration. Do not silently mix the two pairs.
