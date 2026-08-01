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
      name: "core-slice-reaches-sibling-slice",
      severity: "error",
      comment:
        "A core slice imported a sibling's implementation instead of its published reference " +
        "interface. A core slice may import ownerless shared values from core/_shared or a " +
        "sibling's direct reference.ts, but sibling models, rules, errors, and other implementation " +
        "details remain private. Core decides, it does not gather (ARCHITECTURE.md §2).",

      from: { path: "^src/core/([^/]+)/", pathNot: "^src/core/_shared/" },
      to: {
        path: "^src/core/[^/]+/",
        pathNot: ["^src/core/_shared/", "^src/core/$1/", "^src/core/[^/]+/reference\\.ts$"],
      },
    },
    {
      // Two things under src/ are in reach of the assembly, and nothing else
      // is: a slice's operations.ts, which is what it composes, and
      // shell/_shared, which holds what the assembly is itself built from —
      // the ValidationGate it fixes across every group. Core is out with the
      // rest, so an import of `src/core/**` from here trips this too.
      name: "api-assembly-imports-beyond-operations",
      severity: "error",
      comment:
        "src/shell/api.ts imported something other than a slice's operations.ts or " +
        "shell/_shared. The assembly composes operation definitions and nothing else. A slice's " +
        "handlers.ts *must* import api.ts, because HttpApiBuilder.group takes the assembled " +
        "HttpApi as its first argument, so the acyclic direction is the one this rule holds: " +
        "api.ts imports operation definitions, implementations import api.ts, and the layer assembly that " +
        "composes them lives in http.ts one file over (ARCHITECTURE.md §1).",
      from: { path: "^src/shell/api\\.ts$" },
      to: {
        path: "^src/",
        pathNot: ["^src/shell/_shared/", "^src/shell/[^/]+/operations\\.ts$"],
      },
    },
    {
      name: "entrypoint-is-imported",
      severity: "error",
      comment:
        "Something imported src/main.ts. The entrypoint is where the program runs and " +
        "nothing else (ARCHITECTURE.md §1): importing it means running it as a side effect " +
        "of a build. Whatever you need from it belongs in a layer under shell/.",
      from: { path: "^src/" },
      to: { path: "^src/main\\.ts$" },
    },
    {
      name: "cycle",
      severity: "error",
      comment:
        "These modules import each other, directly or through a chain. The graph is acyclic " +
        "(ARCHITECTURE.md §1) — a cycle means two files are one module that has not admitted " +
        "it yet, and under ESM it also means one of them observes the other half-initialised.",
      from: { path: "^src/" },
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
      from: { path: "^src/" },
      // `pathNot` rather than an `^src/` prefix on `path`: anchoring the whole
      // thing needs `(.*/)?`, which the cruiser rejects as an unsafe regex.
      to: { path: "/index\\.(ts|mts|cts|js|mjs|cjs)$", pathNot: "^node_modules/" },
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
