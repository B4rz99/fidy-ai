# Foldkit frontend

The installed, integrity-locked `foldkit@0.165.0` package is the application API authority.
It uses the repository's Effect 4.0.0 and `@effect/platform-browser@4.0.0`. Consult
`node_modules/foldkit/dist/` implementation and declarations before extending it; do not assume
examples for a newer release match this version.

## Upstream source map

`.repos/foldkit` is a squashed checkout of https://github.com/foldkit/foldkit,
upstream `main` at `0cc0d50dab9fc7757f495bd05ae70c4a10fd865c` (package version 0.167.0).
It is a newer reference, not a replacement for the installed declarations.

| Area                                       | Source                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Runtime, application and element ownership | `packages/foldkit/src/runtime/`                                             |
| HTML rendering and scoped DOM resources    | `packages/foldkit/src/html/`, `packages/foldkit/src/mount/`                 |
| Commands and persistent subscriptions      | `packages/foldkit/src/command/`, `packages/foldkit/src/subscription/`       |
| Routing and browser navigation             | `packages/foldkit/src/route/`, `packages/foldkit/src/navigation/`           |
| State transitions and submodels            | `packages/foldkit/src/update/`, `packages/foldkit/src/submodel/`            |
| Framework test helpers                     | `packages/foldkit/src/test/`                                                |
| UI component architecture                  | `packages/ui/src/`, `examples/ui-showcase/`                                 |
| Complete programs                          | `examples/auth/`, `examples/routing/`, `examples/form/`, `examples/kanban/` |

Read the relevant implementation and example before designing a feature. Verify every chosen
API against `node_modules/foldkit/dist/`. Refresh this checkout using the update-repos skill,
then update the revision and version above.

## Runtime ownership

Use `Runtime.makeApplication` for the routed application and `Runtime.makeElement` with
`Runtime.embed` for independently mounted elements. An embedded container needs a nonempty ID.
Foldkit owns the view, Model, messages, update function, commands and subscriptions. Pass the generated
client's existing layer as resources to retain browser transport policy.

Sources: `dist/runtime/runtime.js`, `dist/runtime/start.js`, and `dist/runtime/public.d.ts`.
`embed` returns a handle whose `dispose` interrupts the runtime fiber. Clear private capabilities
synchronously before disposal, and guard late results because interruption finalization is asynchronous.
Test mount, disposal and remount behavior as well as the built browser artifact.

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
