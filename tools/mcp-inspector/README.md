# Inspector transport diagnostics

This optional, isolated tool runs Inspector 2.11.0 with the pinned Undici 8.12.3 dispatcher.
It is not part of Fidy's application dependencies or production deployment.

```sh
bun install --cwd tools/mcp-inspector --frozen-lockfile
bun run --cwd tools/mcp-inspector check
bun run --cwd tools/mcp-inspector test
bun run --cwd tools/mcp-inspector start --config /private/path/inspector-config.json
```

The preload replaces the dispatcher in this Node process only. It retains HTTP/2 multiplexing,
normal TLS certificate verification, and Inspector's OAuth behavior. Do not export a global
`NODE_OPTIONS` workaround or turn off TLS verification. Inspector's proxy configuration remains
its own responsibility; the verified reproduction uses a direct connection.

On Node 26.5.0 (bundled Undici 8.7.0), the default dispatcher queues a cancellation POST while the
legacy review SSE response remains open. The same pinned MCP client and loopback HTTP/2 server
complete cancellation with the replacement dispatcher. The bundled HTTP/2 `busy(request)` still
serializes nonempty stream/async-iterable request bodies behind active work; the selected external
Undici's `lib/dispatcher/client-h2.js` permits those independent streams. This is an operator-client
transport workaround, not a Fidy server cancellation-policy change.

To reproduce the original failure on that Node runtime, omit the preload:

```sh
FIDY_INSPECTOR_BASELINE=1 bun run --cwd tools/mcp-inspector test
```

The reproduction also holds with the policy-eligible Inspector 2.11.0 / MCP client 2.3.1 pins.
The Workspace Gate installs this isolated lockfile and runs the two transport regressions.
Both baseline cases failed with `cancellationReceived: false` during the 21 October audit; both
normal cases passed. The tests use the actual pinned MCP client transport, a disposable bearer,
and a loopback TLS server advertising 100 concurrent streams. They test cancellation alone and
another tool read while the review is pending. OpenSSL generates a temporary certificate, trusted
only by each child process; teardown removes its private directory and closes sockets. No production
credentials, financial records, model inference, or external network are used.

These tests establish dispatch and synthetic cancellation completion. The Fidy legacy integration
tests separately cover native accept/cancel/decline with real canonical work and isolated D1 after
6 and 30 seconds. The 21 October production rerun subsequently passed: the corrected launcher completed native Cancel
for the exact synthetic recurring stop-tracking request with `user_action_required`. Its seven-day
read/write grant was revoked immediately, and independent browser readback retained the plan.
The owning MCP FEATURE.md records the scope and timing. This establishes that operation through
this launcher; it does not certify an unmodified Inspector using the affected Node dispatcher.
A new production grant requires explicit User approval, followed by revocation after testing.
