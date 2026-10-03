export default {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      comment: "CLI composition and owner interfaces must be acyclic.",
      from: {},
      to: { circular: true },
    },
    {
      name: "unresolved",
      severity: "error",
      comment:
        "An unresolved import would escape ownership enforcement; fix its owning declaration or resolution.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "cli-consumes-server-publication",
      severity: "error",
      comment:
        "The CLI derives from the outward declaration seam, never foreign server implementation.",
      from: { path: "^(src|test)/" },
      to: { path: "^\\.\\./server/", pathNot: "^\\.\\./server/src/client\\.ts$" },
    },
    {
      name: "owner-private",
      severity: "error",
      comment:
        "Foreign CLI owners consume Published Trio interfaces, not private files or fixtures.",
      from: { path: "^(src/[^/]+/)" },
      to: {
        path: "^src/[^/]+/",
        pathNot: ["^$1", "^src/[^/]+/(contract|operations|runtime)\\.ts$"],
      },
    },
    {
      name: "declarations-are-pure",
      severity: "error",
      comment:
        "CLI contracts declare schemas and ports, never executable workflow or runtime authority.",
      from: { path: "^src/[^/]+/contract\\.ts$" },
      to: { path: "^src/", pathNot: "^src/[^/]+/contract\\.ts$" },
    },
    {
      name: "runtime-construction-at-composition",
      severity: "error",
      comment:
        "Native storage and raw transport construction belongs to runtime or explicit application/test composition.",
      from: { path: "^src/", pathNot: ["^src/main\\.ts$", "/runtime\\.ts$", "\\.test\\.ts$"] },
      to: { path: "^src/[^/]+/runtime\\.ts$" },
    },
    {
      name: "production-never-imports-tests",
      severity: "error",
      comment:
        "Loopback transport and synthetic test premises can never enter the executable graph.",
      from: { path: "^src/", pathNot: "\\.test(?:-fixture)?\\.ts$" },
      to: { path: "^test/|\\.test(?:-fixture)?\\.ts$" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.dependencies.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules|dist/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};
