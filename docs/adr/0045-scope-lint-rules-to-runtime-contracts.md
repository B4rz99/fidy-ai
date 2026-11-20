# Scope lint rules to runtime contracts

Require explicit file extensions where Node ESM loads local tooling and where Vite resolves raw
assets used by configuration. Named exports remain the application convention. Platform entrypoints
use the default export required for discovery by Workers, Alchemy, Vite, or Vitest.

Keep the deep-readonly parameter check at the pure core boundary. Effect's `DateTime.Utc` has a
lazy internal cache, the `Brand` and `Option` types have phantom type fields, the deep-readonly
check loses the recursive alias for `Json`, and `SchemaError` has a mutable declaration for its
issue tree. Permit these narrowly scoped core types while keeping property reassignment banned and
allowing brands only on scalars. The type-aware negative probes exercise both rules.

The two exported Router factories retain inferred results so TanStack Router can derive routes.
The local lint rule requires result annotations on other named functions in that file. Limit
React effects to specific browser lifecycle boundaries, including restoring Router-owned scroll
after asynchronous Transaction rendering and retiring budget writes on month or authentication
disposal.

The Effect compiler's `@effect-expect-leaking` tag records the context supplied outside approved
middleware. The JSDoc rule recognizes that tag so the compiler can check the exact intentional
requirement independently.

Scan lint suppressions outside the linter so an inline suppression cannot also silence its own
check. Enumerate the Git index and visible working files, and allow for deleted paths that are
still in the index. Select CI jobs from both sides of a move and use local Git history to avoid
the changed-file API's file-count limit. Unknown paths trigger the broad check set.
