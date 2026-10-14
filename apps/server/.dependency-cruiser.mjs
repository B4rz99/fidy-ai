/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "native-composition-root-backedge",
      severity: "error",
      comment:
        "Owner implementations never import native application roots; roots compose their published interfaces (#615).",
      from: {
        path: "^(src|cloudflare)/",
        pathNot: [
          "\\.test\\.ts$",
          "^cloudflare/oauth-agents/oauth-ingress\\.test-fixture\\.ts$",
          "^cloudflare/canonical-request-observer\\.test-fixture\\.ts$",
          "^cloudflare/core-worker\\.test-fixture\\.ts$",
          "^cloudflare/provider-authentication/journey\\.test-fixture\\.ts$",
          "^cloudflare/(core-worker|public-worker|operational-canary-workflow|browser-acceptance-preview)\\.ts$",
          "^cloudflare/ingestion/email-worker\\.ts$",
          "\\.d\\.mts$",
        ],
      },
      to: {
        path: "^cloudflare/((core-worker|public-worker|operational-canary-workflow)\\.ts|ingestion/email-worker\\.ts)$",
      },
    },
    {
      name: "browser-publication-target",
      severity: "error",
      comment:
        "The single browser publication re-publishes only final owner declarations and explicit browser-safe operations (#615).",
      from: {
        path: "^src/client\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot: [
          "^src/core/(browser-login|budgets|categories|dashboard|email-authentication|identity|ingestion|insights|recovery|subscription|tokens)/contract\\.ts$",
          "^src/core/tokens/operations\\.ts$",
          "^src/core/transactions/contract\\.ts$",
          "^src/core/_shared/money\\.ts$",
          "^src/core/_shared/context\\.ts$",
          "^src/shell/api\\.ts$",
          "^src/shell/observability/contract\\.ts$",
          "^src/shell/authorization/runtime\\.ts$",
          "^src/shell/(agent|canonical-operations|processing-consent|connections|dashboard|email-authentication|oauth-agents|operations|public-http|quotas|subscription|tokens|web-authentication)/contract\\.ts$",
          "^src/shell/canonical-policy/operations\\.ts$",
        ],
      },
    },
    {
      name: "server-imports-browser-publication",
      severity: "error",
      comment:
        "Server implementation consumes final owner interfaces, never the outward browser publication root (#615).",
      from: {
        path: "^(src/(core|shell)/|cloudflare/)",
      },
      to: {
        path: "^src/client\\.ts$",
      },
    },
    {
      name: "maintenance-imports-owner-implementation",
      severity: "error",
      comment:
        "Maintenance composes published owner runtimes and declarations only; SQL, policies, admission and lifecycle implementations remain with their owners (#614).",
      from: {
        path: "^cloudflare/maintenance/",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: ["^cloudflare/", "^src/(core|shell)/"],
        pathNot: [
          "^cloudflare/maintenance/",
          "^cloudflare/.+/(contract|runtime)\\.ts$",
          "^src/(core|shell)/[^/]+/(contract|runtime)\\.ts$",
        ],
      },
    },
    {
      name: "maintenance-owner-backedge",
      severity: "error",
      comment:
        "Owners do not depend on their scheduler. The Email Worker entrypoint composes its narrow owner and Maintenance runtimes without a cycle (#614).",
      from: {
        path: "^cloudflare/[^/]+/",
        pathNot: [
          "^cloudflare/maintenance/",
          "^cloudflare/ingestion/email-worker\\.ts$",
          "\\.test\\.ts$",
        ],
      },
      to: {
        path: "^cloudflare/maintenance/(operations|runtime)\\.ts$",
      },
    },
    {
      name: "onboarding-imports-unpublished-native-authority",
      severity: "error",
      comment:
        "The data-free coordinator invokes published owners; persistence and runtime authority stay private (#611).",
      from: {
        path: "^cloudflare/onboarding/",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^cloudflare/",
        pathNot: [
          "^cloudflare/onboarding/",
          "^cloudflare/(consent|email-authentication|identity|provider-authentication|recovery|secret-material)/(contract|operations)\\.ts$",
        ],
      },
    },
    {
      name: "web-authentication-imports-unpublished-native-authority",
      severity: "error",
      comment:
        "The data-free coordinator invokes published owners; persistence and runtime authority stay private (#610).",
      from: {
        path: "^cloudflare/web-authentication/",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^cloudflare/",
        pathNot: [
          "^cloudflare/web-authentication/",
          "^cloudflare/(browser-login|email-authentication|onboarding|recovery|tokens|web-session)/(contract|operations)\\.ts$",
        ],
      },
    },
    {
      name: "core-imports-the-world",
      severity: "error",
      comment:
        'A module under src/core imported the platform or an I/O builtin. This is the rule that actually holds "core is testable without a container": every path-scoped fence would permit `import { FileSystem } from "@effect/platform"` inside a core module, because the import never touches src/shell/ at all (ARCHITECTURE.md §3). Whatever the value is, take it as a parameter and let the shell read it.',
      from: {
        path: "^src/core/",
      },
      to: {
        path: "(^|.*/)node_modules/@effect/platform|(^|.*/)node_modules/effect/(dist|src)/(http|http-api)(/|$)|^(node:|bun:)|^(fs|http|https|net|os|child_process|stream|dns|tls|timers|cluster|worker_threads)(/|$)",
      },
    },
    {
      name: "provider-callers-import-raw-http",
      severity: "error",
      comment:
        "Portable provider adapters and native billing adapter tests consume Outbound HTTP instead of raw transport. Native runtime construction may bind its client; type declarations carry no execution authority.",
      from: {
        path: "^src/shell/(channels/whatsapp|subscription)/|^cloudflare/subscription/.*\\.test\\.ts$",
      },
      to: {
        path: "(^|.*/)node_modules/effect/(dist|src)/http(/|$)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "api-assembly-imports-beyond-operations",
      severity: "error",
      comment:
        "The canonical API landmark composes only published declaration contracts and its catalog. It cannot acquire execution, registry, provider, storage or runtime authority. Implementations depend on the assembled API, never the reverse (#612).",
      from: {
        path: "^src/shell/api\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot: [
          "^src/shell/public-http/contract\\.ts$",
          "^src/shell/(identity|categories|transactions|subscription|budgets|dashboard|insights|recurring|connections|email-authentication|tokens|browser-login|recovery|ingestion|memory|quotas|canonical-catalog|authorization|operations)/contract\\.ts$",
        ],
      },
    },
    {
      name: "hosted-inference-orchestration-imports-provider",
      severity: "error",
      comment:
        "Agent and Memory orchestration invoke HostedInference; model and tokenizer execution stays behind its budgets and provider-neutral interface.",
      from: {
        path: "^(src/shell|cloudflare)/(agent|memory)/",
      },
      to: {
        path: "(^|.*/)node_modules/effect/(dist|src)/ai/(index|LanguageModel|Tokenizer)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "cycle",
      severity: "error",
      comment:
        "These modules import each other, directly or through a chain. The graph is acyclic (ARCHITECTURE.md §1) — a cycle means two files are one module that has not admitted it yet, and under ESM it also means one of them observes the other half-initialised.",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
      },
      to: {
        circular: true,
      },
    },
    {
      name: "same-directory-import-is-aliased",
      severity: "error",
      comment:
        "An import of a neighbouring file went through the `~/` alias. Within one directory imports are relative, so a reader sees at a glance that the target is local and a whole directory can move without rewriting its own internals. Use `./name`.",
      from: {
        path: "^(src/|src/.*/)[^/]+$",
      },
      to: {
        path: "^$1[^/]+$",
        dependencyTypes: ["aliased-tsconfig-paths"],
      },
    },
    {
      name: "cross-directory-import-is-relative",
      severity: "error",
      comment:
        "An import that leaves its directory was written relatively. Across directories imports are aliased (`~/core/transactions/contract`), so a crossing is visible as one and `../../` never has to be counted. Use the `~/` alias.",
      from: {
        path: "^(src/|src/.*/)[^/]+$",
      },
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
        "Something imported an index file. Barrels hide where a symbol actually lives, make every importer depend on every re-export, and turn a directory into a cycle waiting to happen. Import the defining module directly.",
      from: {
        path: "^(src|scripts|tools)/",
      },
      to: {
        path: "/index\\.(ts|mts|cts|js|mjs|cjs)$",
        pathNot: "(^|.*/)node_modules/",
      },
    },
    {
      name: "browser-client-seam-bypass",
      severity: "error",
      comment:
        "Source outside portable owners reaches shell declarations only through the package client publication; application landmarks are not additional client seams.",
      from: {
        path: "^src/",
        pathNot: ["^src/(core|shell)/", "^src/client\\.ts$"],
      },
      to: {
        path: "^src/shell/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.dependencies.json",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
