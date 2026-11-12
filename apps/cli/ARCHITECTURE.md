# CLI architecture

`apps/cli` is Fidy's Bun terminal client. It presents browser-approved login, local credential
management and server-derived canonical operations in human-readable or machine-readable form.
Read the repository [architecture](../../ARCHITECTURE.md) for cross-application boundaries.

## Ownership and execution

| Area                 | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| Command presentation | Arguments, discovery, help and terminal-safe output       |
| Login                | Browser-approved pairing and local grant installation     |
| Canonical client     | Schema-derived input, invocation and result presentation  |
| Credential storage   | Native bearer custody and safe local grant metadata       |
| Runtime composition  | Process lifetime, transport and operating-system adapters |

The CLI consumes the server's public client declarations and browser-safe transport resources. Operation schemas and policy drive its
command surface; domain behavior and authorization remain server-owned. Structured input represents
the complete operation contract, with generated flags for supported scalar inputs.

Support recovery is a separate operator surface using Cloudflare Access authority. It cannot derive
recovery privileges from the saved User credential. See [its feature](src/support-recovery/FEATURE.md).

## Credential exception and local persistence

The CLI owns one saved login bound to the production API origin. Its native credential store is an
intentional recoverable-bearer exception; server storage remains digest-only. macOS Keychain, Linux
Secret Service and Windows Credential Manager provide custody, with no file or environment fallback.
Safe grant metadata is stored separately. The reviewed Bun runtime is pinned because native storage
behavior is part of this boundary.

The browser approves the grant and the CLI claims it. Status reports local availability; logout
removes local access. Remote revocation and grant management remain server operations. Credential
material stays outside command arguments, URLs and diagnostic output.

## Failure and distribution boundaries

The transport owns bounded requests and safe result decoding. An uncertain mutation or one-time
credential claim cannot be replayed automatically. Local cancellation does not imply server rollback,
and accepted background work does not imply completion.

Standalone releases bundle the same client and native credential adapters. CI owns platform packaging
and release verification; the web hosts installers and the API supplies release discovery.

## Further reading

- [CLI guide](../docs/src/content/docs/conectar/cli.md): installation and User workflows.
- [Runtime evidence](../../docs/research/bun-1-4-4-runtime-compatibility-2026-10-31.md): reviewed native behavior.
- [Security standards](../../SECURITY_STANDARDS.md): credential and transport invariants.
- [Release tooling](../../scripts/cli-release/): packaging and verification implementation.
