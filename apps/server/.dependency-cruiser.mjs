// The module-graph gate. `bun run lint:deps` runs it, `bun run verify` and CI
// run it too — a rule a tool could enforce, but no tool runs, is not a standard
// (CODING_STANDARDS.md).
//
// oxlint holds the per-file rules; the rules here are the ones that are about
// the graph rather than about a file. The dividing line is whether the target
// can be written in terms of the source: "a core slice may import a sibling only
// through reference.ts" needs one relational rule with a back-reference, where oxlint's
// deny-pattern-only `no-restricted-imports` would need an override block per
// slice enumerating every other slice, rotting on the next slice added.
//
// The core-to-shell fence is deliberately stated in both tools. It is the one
// rule the whole two-tree shape rests on, and each tool catches it in a
// different place: oxlint at the import statement as you type, this at the
// resolved graph, including a hop that launders itself through a re-export.
//
// Every rule's `comment` is what the reporter prints when it fires, so each one
// explains the reason rather than restating the pattern.
//
// `tools/depcruise/run.mjs` is the entry point, not the `depcruise` binary: the
// cruiser needs the classic TypeScript compiler API, which the root's Effect
// tsgo `typescript` build does not expose, and without it it cruises zero
// modules and still exits 0.

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "core-imports-shell",
      severity: "error",
      comment:
        "A module under src/core imported one under src/shell. Core does not know shell " +
        "exists — no interface, no callback, no inversion trick; the arrow points one way " +
        "(ARCHITECTURE.md §1). Take what you need as a plain parameter and let the shell " +
        "supply it, or move the operation to shell/.",
      from: { path: "^src/core/" },
      to: { path: "^src/shell/" },
    },
    {
      name: "core-imports-the-world",
      severity: "error",
      comment:
        "A module under src/core imported the platform or an I/O builtin. This is the rule " +
        'that actually holds "core is testable without a container": every path-scoped fence ' +
        'would permit `import { FileSystem } from "@effect/platform"` inside a core module, ' +
        "because the import never touches src/shell/ at all (ARCHITECTURE.md §3). Whatever the " +
        "value is, take it as a parameter and let the shell read it.",
      from: { path: "^src/core/" },
      to: {
        path:
          "(^|.*/)node_modules/@effect/platform|" +
          "^(fs|http|https|net|os|child_process|stream|dns|tls|timers|cluster|worker_threads)(/|$)",
      },
    },
    {
      name: "core-slice-reaches-sibling-slice",
      severity: "error",
      comment:
        "A core slice imported a sibling's implementation instead of a published interface. " +
        "A core slice may import ownerless shared values from core/_shared or a sibling's direct " +
        "reference.ts, contract.ts, or operations.ts, but sibling models, rules, errors, and other " +
        "implementation details remain private. Core decides, it does not gather " +
        "(ARCHITECTURE.md §2).",

      from: { path: "^src/core/([^/]+)/", pathNot: "^src/core/_shared/" },
      to: {
        path: "^src/core/[^/]+/",
        pathNot: [
          "^src/core/_shared/",
          "^src/core/$1/",
          "^src/core/[^/]+/(reference|contract|operations)\\.ts$",
        ],
      },
    },
    {
      name: "foreign-module-imports-internal",
      severity: "error",
      comment:
        "A module imported another module's internal implementation. `internal/` is visibly " +
        "private across core and shell, including to tests and same-named owners in the other " +
        "layer. Move the caller to the owner's contract.ts or operations.ts interface.",
      from: {
        path: "^src/(core|shell)/([^/]+)/",
      },
      to: {
        path: "^src/(core|shell)/[^/]+/internal/",
        pathNot: "^src/$1/$2/internal/",
      },
    },
    {
      name: "provider-callers-import-raw-http",
      severity: "error",
      comment:
        "An external-provider adapter test imported Effect's raw HTTP client instead of the " +
        "published Outbound HTTP test seam. Keep raw transport inside shell/outbound-http so " +
        "destinations, credentials, redirects, tracing, and body bounds cannot be bypassed " +
        "(apps/server/ARCHITECTURE.md §3).",
      from: {
        path:
          "^src/shell/(agent/__probe-[0-9]+-provider-raw-http/probe\\.test\\.ts|" +
          "channels/whatsapp/kapso-client\\.test\\.ts|" +
          "subscription/wompi-(billing-)?client\\.test\\.ts)$",
      },
      to: {
        path: "^(?:\\.\\./)*node_modules/effect/dist/unstable/http/index\\.js$",
      },
    },
    {
      name: "tooling-imports-internal",
      severity: "error",
      comment:
        "A script or tool imported a module's internal implementation. Operational tooling obeys " +
        "the same privacy boundary as production code: import contract.ts, operations.ts, or a " +
        "justified runtime.ts composition interface instead.",
      from: { path: "^(scripts|tools)/" },
      to: { path: "^src/(core|shell)/[^/]+/internal/" },
    },
    {
      name: "landmark-imports-internal",
      severity: "error",
      comment:
        "A source landmark outside an owner module imported visible internals. Application assembly " +
        "may compose published runtime.ts interfaces, but it does not bypass module privacy.",
      from: { path: "^src/", pathNot: "^src/(core|shell)/[^/]+/" },
      to: { path: "^src/(core|shell)/[^/]+/internal/" },
    },
    {
      name: "contract-imports-implementation",
      severity: "error",
      comment:
        "contract.ts is the independent declaration interface. It may depend on contracts, but not " +
        "on private implementation, substantive operations, or runtime composition.",
      from: { path: "^src/(core|shell)/(.+)/contract\\.ts$" },
      to: { path: "^src/(core|shell)/.+/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "internal-imports-outward-interface",
      severity: "error",
      comment:
        "Private implementation depended backward on its module's outward operations.ts or " +
        "runtime.ts interface. Internals may depend on their contract and sibling internals; the " +
        "published facades depend inward, never the reverse.",
      from: { path: "^src/(core|shell)/(.+)/internal/" },
      to: { path: "^src/$1/$2/(operations|runtime)\\.ts$" },
    },
    {
      name: "operations-imports-runtime",
      severity: "error",
      comment:
        "operations.ts depended backward on its module's runtime.ts. Runtime composition may " +
        "assemble operations, but substantive operations do not acquire construction or startup authority.",
      from: { path: "^src/(core|shell)/(.+)/operations\\.ts$" },
      to: { path: "^src/$1/$2/runtime\\.ts$" },
    },
    {
      name: "published-interface-reexports-internal",
      severity: "error",
      comment:
        "A published interface re-exported private implementation. contract.ts, operations.ts, and " +
        "runtime.ts may use internals in their permitted direction, but must declare the interface " +
        "they publish instead of laundering internal exports.",
      from: { path: "^src/(core|shell)/(.+)/(contract|operations|runtime)\\.ts$" },
      to: {
        path: "^src/$1/$2/internal/",
        dependencyTypes: ["export"],
      },
    },
    {
      name: "foreign-runtime-imported-outside-composition",
      severity: "error",
      comment:
        "An ordinary module imported another module's runtime.ts. Foreign runtime authority is " +
        "reserved for runtime.ts composition, exact application landmarks, named broad harnesses, " +
        "and justified scripts or tools; use contract.ts or operations.ts for ordinary calls.",
      from: {
        path: "^src/(core|shell)/([^/]+)/",
        pathNot: ["/runtime\\.ts$", "^src/shell/testing/.*(?:harness|runtime)\\.ts$"],
      },
      to: {
        path: "^src/(core|shell)/[^/]+/runtime\\.ts$",
        pathNot: "^src/$1/$2/runtime\\.ts$",
      },
    },
    {
      name: "tooling-imports-runtime-without-composition-role",
      severity: "error",
      comment:
        "A script or tool imported runtime authority without being an explicitly named runtime or harness. " +
        "Tooling uses contract.ts or operations.ts by default; a composition entrypoint makes that broader " +
        "role visible in its filename.",
      from: {
        path: "^(scripts|tools)/",
        pathNot: ["(?:runtime|harness)\\.ts$"],
      },
      to: { path: "^src/(core|shell)/[^/]+/runtime\\.ts$" },
    },
    {
      // Three things under src/ are in reach of the assembly, and nothing else
      // is: a slice's operations.ts, which is what it composes; shell/_shared,
      // which still holds canonical declaration assembly; and Public HTTP's
      // contract, which declares the ValidationGate fixed across every group.
      // Core is out with the rest, so an import of `src/core/**` from here trips this too.
      name: "api-assembly-imports-beyond-operations",
      severity: "error",
      comment:
        "src/shell/api.ts imported something other than a slice's operations.ts, " +
        "shell/_shared, or the Public HTTP contract. The assembly composes operation definitions " +
        "and their universal validation declaration and nothing else. A slice's " +
        "handlers.ts *must* import api.ts, because HttpApiBuilder.group takes the assembled " +
        "HttpApi as its first argument, so the acyclic direction is the one this rule holds: " +
        "api.ts imports operation definitions, implementations import api.ts, and the layer assembly that " +
        "composes them lives in http.ts one file over (ARCHITECTURE.md §1).",
      from: { path: "^src/shell/api\\.ts$" },
      to: {
        path: "^src/",
        pathNot: [
          "^src/shell/_shared/",
          "^src/shell/public-http/contract\\.ts$",
          "^src/shell/[^/]+/operations\\.ts$",
        ],
      },
    },
    {
      // The package-level facade is the only browser-facing source allowed to reach shell modules
      // from outside the server tree. A future web package can depend on `src/client.ts`; it must
      // not know whether the canonical declaration currently lives under shell/.
      name: "browser-client-seam-bypass",
      severity: "error",
      comment:
        "Code outside src/shell imported a server-internal shell module directly. The browser " +
        "depends on the package-level client facade (`src/client.ts` / future `@fidy/server/client`), " +
        "which preserves one canonical API without making shell paths public.",
      from: {
        path: "^src/",
        pathNot: ["^src/shell/", "^src/main\\.ts$", "^src/client\\.ts$"],
      },
      to: { path: "^src/shell/" },
    },
    {
      // Keep the facade narrow even while the dependency graph is being assembled: the transitive
      // browser build performs the stronger allowlist check below, while this catches a direct
      // accidental import before a build has to explain it.
      name: "browser-client-facade-imports-server-code",
      severity: "error",
      comment:
        "The browser client facade imported a shell implementation directly. It may expose only " +
        "the assembled FidyApi, declaration-only client authorization, and derived operation projections; " +
        "live middleware and server adapters stay behind the server assembly.",
      from: { path: "^src/client\\.ts$" },
      to: {
        path: "^src/shell/",
        pathNot: [
          "^src/shell/api\\.ts$",
          "^src/shell/_shared/authz\\.ts$",
          "^src/shell/_shared/canonical-input\\.ts$",
          "^src/shell/_shared/canonical-success\\.ts$",
          "^src/shell/(public-http|schema-codecs|tokens|subscription|web-auth)/contract\\.ts$",
          "^src/shell/email-authentication/(contract|path)\\.ts$",
        ],
      },
    },
    {
      name: "browser-login-repository-reached-outside-owner",
      severity: "error",
      comment:
        "A module outside BrowserLogin imported BrowserLogin persistence directly. BrowserLogin " +
        "alone owns pairing binding and WebSession creation; cross-slice coordination must call " +
        "an owner-published BrowserLogin operation so its transition invariants remain local " +
        "(ARCHITECTURE.md §2).",
      from: { path: "^src/shell/", pathNot: "^src/shell/browser-login/" },
      to: { path: "^src/shell/browser-login/repo\\.ts$" },
    },
    {
      name: "hosted-inference-orchestration-imports-provider",
      severity: "error",
      comment:
        "Agent or Memory orchestration, or the published HostedInference interface, imported " +
        "provider-specific code. Provider models, clients, tokenizers, capacity, wire requests, " +
        "and raw responses belong only in HostedInference internals (ADR 0014).",
      from: {
        path: "^src/shell/(agent/(agent-service\\.ts|working-context\\.ts|__probe-.*hosted-(provider|model|tokenizer|js-tokenizer)/probe\\.ts)|memory/(memory-policy\\.ts|__probe-.*hosted-(provider|model|tokenizer|js-tokenizer)/probe\\.ts)|hosted-inference/(contract|operations)\\.ts)$",
      },
      to: {
        path: "(^|.*/)node_modules/effect/.*/unstable/ai/(index|LanguageModel|Tokenizer)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "cycle",
      severity: "error",
      comment:
        "These modules import each other, directly or through a chain. The graph is acyclic " +
        "(ARCHITECTURE.md §1) — a cycle means two files are one module that has not admitted " +
        "it yet, and under ESM it also means one of them observes the other half-initialised.",
      from: { path: "^(src|scripts|tools)/" },
      to: { circular: true },
    },
    // The next two rules are exact complements, and both hang off the same
    // capture: `$1` is the importing file's own directory, trailing slash and
    // all. `^(src/|src/.*/)` rather than a pattern per tree depth, because a
    // pattern per depth is how `src/main.ts`, `src/shell/api.ts` and
    // `src/shell/http.ts` came to sit outside both rules while the pair read as
    // complete — the earlier `^src/(core|shell)/([^/]+)/` needed two levels
    // below `src/` and quietly exempted everything shallower. Written as an
    // alternation because `(.*/)?` says the same thing and the cruiser rejects
    // it as an unsafe regex.
    //
    // "Its directory" is the directory the file is in, not the subtree beneath
    // it: an import that descends into a child directory crosses a boundary
    // like any other, and is aliased like any other.
    {
      name: "same-directory-import-is-aliased",
      severity: "error",
      comment:
        "An import of a neighbouring file went through the `~/` alias. Within one directory " +
        "imports are relative, so a reader sees at a glance that the target is local and a " +
        "whole directory can move without rewriting its own internals. Use `./name`.",
      from: { path: "^(src/|src/.*/)[^/]+$" },
      to: {
        path: "^$1[^/]+$",
        dependencyTypes: ["aliased-tsconfig-paths"],
      },
    },
    {
      name: "cross-directory-import-is-relative",
      severity: "error",
      comment:
        "An import that leaves its directory was written relatively. Across directories " +
        "imports are aliased (`~/core/transactions/model`), so a crossing is visible as one " +
        "and `../../` never has to be counted. Use the `~/` alias.",
      from: { path: "^(src/|src/.*/)[^/]+$" },
      to: {
        path: "^src/",
        pathNot: "^$1[^/]+$",
        dependencyTypesNot: ["aliased"],
      },
    },
    {
      name: "barrel-file",
      severity: "error",
      comment:
        "Something imported an index file. Barrels hide where a symbol actually lives, make " +
        "every importer depend on every re-export, and turn a directory into a cycle waiting " +
        "to happen. Import the defining module directly.",
      from: { path: "^(src|scripts|tools)/" },
      // `pathNot` rather than an `^src/` prefix on `path`: anchoring the whole
      // thing needs `(.*/)?`, which the cruiser rejects as an unsafe regex.
      to: { path: "/index\\.(ts|mts|cts|js|mjs|cjs)$", pathNot: "(^|.*/)node_modules/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // Type-only imports are still edges: `import type { TransactionFailure }`
    // is core knowledge reaching shell, and erasing at compile time does not
    // make it less of an architectural arrow.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
