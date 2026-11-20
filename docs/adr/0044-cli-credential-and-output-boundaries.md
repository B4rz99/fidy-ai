# Keep CLI bearer custody and terminal output separate

The CLI uses one saved native secret and a separate bounded metadata record. Partial persistence is
reported as an inconsistent store so the CLI cannot treat an orphan bearer as an active login or
missing metadata as permission to overwrite a credential. The pinned Bun revision supports
local-machine persistence on Windows. Retrieving the native secret immediately redacts it, and the
installation diagnostic can run without opening the store or making a network request.

Derive an invocation-scoped HTTP client from the canonical endpoint declarations. Discovery can
filter by the saved capabilities, while the server decides live authority at invocation. The dynamic
dispatch table erases individual request types, but the client still validates each request with its
original endpoint codec. The bearer is supplied to this invocation's authorization layer. Login opens
only the first-party approval URL with the public pairing reference. An uncertain claim or canonical
invocation leaves reconciliation to the caller, since replay could duplicate work or lose the
one-time result.

Use the same terminal-safe JSON encoding in human and machine modes. Extra escaping neutralizes
terminal and bidirectional control characters while preserving parseable JSON. Keep result output
and operational guidance on separate streams, and render errors using closed local reasons.
This keeps untrusted provider or server text from controlling the terminal or breaking machine-mode
output. A CLI input reader starts cancellation and releases its lock without waiting for a native
cancellation promise, which may never settle.

Support recovery uses a separate Access-authorized transport with an argument-free, no-echo
terminal prompt. The original browser retains its private verifier. An uncertain recovery request is
resolved by having the original browser inspect its pairing state, since the server may already have
recorded the decision.
