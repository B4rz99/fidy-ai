# Foldkit embedded features

The installed, integrity-locked `foldkit@0.165.0` package is the API authority for this pilot.
It uses the repository's Effect 4.0.0 and `@effect/platform-browser@4.0.0`. Consult
`node_modules/foldkit/dist/` implementation and declarations before extending it; do not assume
examples for a newer release match this version.

## Runtime ownership

Use `Runtime.makeElement` and `Runtime.embed` for a feature hosted by the existing React router.
The container needs a nonempty ID. React owns the callback ref and disposal; Foldkit owns the
element view, Model, messages, update function, commands and subscriptions. Pass the generated
client's existing layer as resources to retain browser transport policy.

Sources: `dist/runtime/runtime.js`, `dist/runtime/start.js`, and `dist/runtime/public.d.ts`.
`embed` returns a handle whose `dispose` interrupts the runtime fiber. Clear private capabilities
synchronously before disposal, and guard late results because interruption finalization is asynchronous.
Test the host under React Strict Mode as well as through the built browser artifact.

## Element scopes and popup gestures

`Html.OnMount` starts on DOM insertion and releases its scope on destruction. Adding an OnMount
attribute to a reused element does not create a new ordinary mount. Give workflow phases explicit
keys when their element-owned resources differ, and key controls that move within a phase.
Source: `dist/html/index.js`, the OnMount handler's insert, postpatch and destroy hooks.

A popup must be reserved in the synchronous browser gesture. A scoped native capture listener
opens the blank popup before Foldkit dispatches the asynchronous command; the controller clears
its opener and later navigates it to the server-declared authorization URL.

## Authentication secrets

Model schemas, messages, command arguments/results and history contain public presentation state
only. Keep pairing proof and one-time recovery in the mounted controller. Reveal recovery with
`textContent` through a scoped Mount, then erase it on acknowledgement and disposal. Do not put
it into HTML strings, model serialization, debug output or storage. Set `devTools: false` for auth;
the pilot does not install the Foldkit Vite model-preservation plugin.

Use `Command.define` interruption and persistent subscriptions for scoped work. A monotonically
increasing attempt number rejects queued updates from cancelled attempts; the private controller
also checks its generation before admitting late protocol responses. Sources: `dist/command/`,
`dist/subscription/`, and the Provider Authentication implementation and browser tests.
