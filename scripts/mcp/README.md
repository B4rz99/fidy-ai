# MCP verification

Run the local runner regressions and the complete OAuth/MCP integration suite:

```sh
bun run test:ci-tools
bun run --cwd apps/server test:cloudflare cloudflare/oauth-agents
```

The local confirmation bridge uses `native-confirmation-hosts.ts`; it never runs Production OAuth.
See the opt-in instructions in the owning confirmation test.

The bridge forwards native acceptance without any per-operation browser decision. Acceptance,
cancellation, and headless cases traverse the same public ingress/Core/User SQLite path. The owner
accepted client-asserted approval in #1564: this harness does not establish physical human presence.
Loopback forwarding rewrites Host along with the fixture URL so public ingress retains Host/Origin
checks. The retained evidence was refreshed for #1564 with Claude Code 2.1.289 and Codex 0.160.0.
