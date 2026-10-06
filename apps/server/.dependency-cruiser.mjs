// The module-graph gate. `bun run lint:deps` runs it, `bun run verify` and CI
// run it too — a rule a tool could enforce, but no tool runs, is not a standard
// (CODING_STANDARDS.md).
//
// oxlint holds the per-file rules; the rules here are the ones that are about
// the graph rather than about a file. The dividing line is whether the target
// can be written in terms of the source: "a core slice may import a sibling only
// through published contracts" needs one relational rule with a back-reference, where oxlint's
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
      name: "test-support-landmark-private",
      severity: "error",
      comment:
        "Scripts and broad application harnesses compose published owner interfaces; they cannot turn private fixtures into shared test APIs (#616).",
      from: { path: "^(scripts/|tools/|cloudflare/[^/]+\\.ts$)" },
      to: { path: "^(src|cloudflare)/.+/(?:test-fixtures\\.ts|[^/]+\\.test-fixture\\.ts)$" },
    },
    {
      name: "production-imports-test-support",
      severity: "error",
      comment:
        "Test bindings, synthetic fixtures and raw provider substitutes never become production authority or Published Trio exports (#616).",
      from: {
        path: "^(src|cloudflare)/",
        pathNot: [
          "\\.test\\.ts$",
          "\\.test-fixture\\.ts$",
          "^src/shell/testing/(credential-evidence-harness|crypto-harness)\\.ts$",
          "^src/shell/outbound-http/testing\\.ts$",
          "^cloudflare/(d1-test-fixture|d1-migration-test-worker\\.fixture|coordinator-test-harness|workflow-test-runtime|browser-acceptance-[^/]+)\\.[cm]?ts$",
        ],
      },
      to: {
        path: [
          "\\.test-fixture\\.ts$",
          "^src/shell/testing/",
          "^src/shell/outbound-http/testing\\.ts$",
          "^cloudflare/(d1-test-fixture|d1-migration-test-worker\\.fixture|coordinator-test-harness|workflow-test-runtime|browser-acceptance-[^/]+)\\.[cm]?ts$",
        ],
      },
    },
    {
      name: "native-test-composition-imports-portable-internal",
      severity: "error",
      comment:
        "Native implementations and test compositions consume portable owner publications; a test or harness filename never grants foreign internal access (#616).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/.+/internal/" },
    },
    {
      name: "test-support-owner-private",
      severity: "error",
      comment:
        "Owner fixtures stay beside their owner; foreign tests use published contracts and operations, never private fixture exports (#616).",
      from: { path: "^(src/(?:core|shell)/(?:channels/)?[^/]+/|cloudflare/[^/]+/)" },
      to: {
        path: "^(src|cloudflare)/.+/(?:test-fixtures\\.ts|[^/]+\\.test-fixture\\.ts)$",
        pathNot: "^$1",
      },
    },
    {
      name: "composition-runtime-outside-root",
      severity: "error",
      comment:
        "HTTP and Queue runtime construction belongs to the Core root or an explicit broad harness, not ordinary owner implementation (#615).",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: ["^cloudflare/core-worker\\.ts$", "\\.test\\.ts$", "(?:runtime|harness)\\.ts$"],
      },
      to: { path: "^cloudflare/(core-http|queue)/runtime\\.ts$" },
    },
    {
      name: "native-composition-root-backedge",
      severity: "error",
      comment:
        "Owner implementations never import native application roots; roots compose their published interfaces (#615).",
      from: {
        path: "^(src|cloudflare)/",
        pathNot: [
          "\\.test\\.ts$",
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
      name: "native-root-imports-internal",
      severity: "error",
      comment:
        "Native roots compose published owner interfaces, never foreign private implementations (#615).",
      from: {
        path: "^cloudflare/((core-worker|public-worker|operational-canary-workflow)\\.ts|ingestion/email-worker\\.ts)$",
      },
      to: { path: "^(src|cloudflare)/.*/internal/" },
    },
    {
      name: "composition-internal-private",
      severity: "error",
      comment:
        "HTTP and Queue dispatch stay private to their named platform composition; consumers construct the published runtime (#615).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/(core-http|queue)/" },
      to: { path: "^cloudflare/(core-http|queue)/internal/" },
    },
    {
      name: "composition-peer-internal-private",
      severity: "error",
      comment:
        "HTTP and Queue are distinct composition owners and cannot import each other's internals (#615).",
      from: { path: "^cloudflare/(core-http|queue)/" },
      to: { path: "^cloudflare/(core-http|queue)/internal/", pathNot: "^cloudflare/$1/internal/" },
    },
    {
      name: "composition-contract-imports-implementation",
      severity: "error",
      comment: "Composition contracts publish only inert binding and handler declarations (#615).",
      from: { path: "^cloudflare/(core-http|queue)/contract\\.ts$" },
      to: { path: "^cloudflare/.*/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "composition-internal-imports-runtime",
      severity: "error",
      comment: "Private dispatch cannot reacquire its outward construction authority (#615).",
      from: { path: "^cloudflare/(core-http|queue)/internal/" },
      to: { path: "^cloudflare/$1/runtime\\.ts$" },
    },
    {
      name: "composition-interface-reexports-internal",
      severity: "error",
      comment:
        "Composition runtimes construct their interface rather than laundering private dispatch exports (#615).",
      from: { path: "^cloudflare/(core-http|queue)/(contract|runtime)\\.ts$" },
      to: { path: "^cloudflare/$1/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "native-composition-cycle",
      severity: "error",
      comment: "Native HTTP, Queue and Worker compositions remain acyclic (#615).",
      from: {
        path: "^cloudflare/(core-http/|queue/|core-worker\\.ts$|public-worker\\.ts$|ingestion/email-worker\\.ts$)",
      },
      to: { circular: true },
    },
    {
      name: "browser-publication-target",
      severity: "error",
      comment:
        "The single browser publication re-publishes only final owner declarations and explicit browser-safe operations (#615).",
      from: { path: "^src/client\\.ts$" },
      to: {
        path: "^src/",
        pathNot: [
          "^src/core/(browser-login|dashboard|email-authentication|ingestion|recovery|subscription|tokens)/contract\\.ts$",

          "^src/core/tokens/operations\\.ts$",
          "^src/core/_shared/context\\.ts$",
          "^src/shell/api\\.ts$",
          "^src/shell/authorization/runtime\\.ts$",
          "^src/shell/(agent|canonical-operations|email-authentication|oauth-agents|operations|public-http|quotas|subscription|tokens|web-authentication)/contract\\.ts$",
          // Pure shared access decisions are deliberate CLI/browser discovery authority (#970).
          "^src/shell/canonical-policy/operations\\.ts$",
        ],
      },
    },
    {
      name: "server-imports-browser-publication",
      severity: "error",
      comment:
        "Server implementation consumes final owner interfaces, never the outward browser publication root (#615).",
      from: { path: "^(src/(core|shell)/|cloudflare/)" },
      to: { path: "^src/client\\.ts$" },
    },
    {
      name: "maintenance-imports-owner-implementation",
      severity: "error",
      comment:
        "Maintenance composes published owner runtimes and declarations only; SQL, policies, admission and lifecycle implementations remain with their owners (#614).",
      from: { path: "^cloudflare/maintenance/", pathNot: "\\.test\\.ts$" },
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
      name: "maintenance-contract-imports-implementation",
      severity: "error",
      comment:
        "Maintenance declarations remain inert and do not acquire executable scheduling or owner runtime authority (#614).",
      from: { path: "^cloudflare/(maintenance|maintenance/.+)/contract\\.ts$" },
      to: { path: "^cloudflare/.+/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "maintenance-operations-imports-runtime",
      severity: "error",
      comment:
        "Schedule execution is independent of runtime construction; only the composition interface binds owners (#614).",
      from: { path: "^cloudflare/(maintenance|maintenance/.+)/operations\\.ts$" },
      to: { path: "^cloudflare/.+/runtime\\.ts$" },
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
      to: { path: "^cloudflare/maintenance/(operations|runtime)\\.ts$" },
    },
    {
      name: "platform-maintenance-internal-private",
      severity: "error",
      comment:
        "Platform scheduled health and retention internals remain private; callers use the published platform runtime (#614).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/runtime/" },
      to: { path: "^cloudflare/runtime/internal/" },
    },
    {
      name: "scheduled-interface-reexports-internal",
      severity: "error",
      comment:
        "Published scheduling and platform interfaces declare their contract rather than laundering private implementation (#614).",
      from: { path: "^cloudflare/(maintenance|runtime)/.*(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/$1/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "scheduled-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Private scheduling and platform implementations depend inward on contracts, never their own outward runtime (#614).",
      from: { path: "^cloudflare/(maintenance|runtime)/internal/" },
      to: { path: "^cloudflare/$1/(operations|runtime)\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-memory-internal",
      severity: "error",
      comment:
        "Memory owns current prose, persistence, capacity and readback. Peers use its published operations, never retained rows or SQL (#607).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/memory/" },
      to: { path: "^cloudflare/memory/internal/" },
    },
    {
      name: "cloudflare-imports-portable-memory-internal",
      severity: "error",
      comment:
        "Native Memory consumes only portable declarations and operations; formatting, model-adapter and private implementation remain owner-local (#607).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/memory/internal/" },
    },
    {
      name: "memory-interface-reexports-internal",
      severity: "error",
      comment:
        "Memory publishes substantive behavior rather than laundering private persistence or free-text projections (#607).",
      from: { path: "^cloudflare/memory/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/memory/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "memory-contract-imports-implementation",
      severity: "error",
      comment:
        "Memory declarations are independent of private implementation and runtime construction (#607).",
      from: { path: "^cloudflare/memory/contract\\.ts$" },
      to: { path: "^cloudflare/memory/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "memory-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Memory internals depend inward on private storage and declarations, never backwards on published operations or runtime (#607).",
      from: { path: "^cloudflare/memory/internal/" },
      to: { path: "^cloudflare/memory/(operations|runtime)\\.ts$" },
    },
    {
      name: "memory-operations-imports-runtime",
      severity: "error",
      comment: "Memory operations do not acquire runtime construction authority (#607).",
      from: { path: "^cloudflare/memory/operations\\.ts$" },
      to: { path: "^cloudflare/memory/runtime\\.ts$" },
    },
    {
      name: "native-agent-imports-model-implementation",
      severity: "error",
      comment:
        "Hosted Agent calls its separate HostedInference boundary; provider model and tokenizer execution cannot bypass its budgets or egress policy (#613).",
      from: { path: "^cloudflare/agent/" },
      to: {
        path: "(^|.*/)node_modules/effect/.*/ai/(index|LanguageModel|Tokenizer)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "native-agent-cycle",
      severity: "error",
      comment:
        "Agent runtime, canonical execution and low-level Turn commit operations retain an acyclic ownership graph (#613).",
      from: { path: "^cloudflare/agent/" },
      to: { circular: true },
    },
    {
      name: "cloudflare-imports-portable-agent-internal",
      severity: "error",
      comment:
        "Native Agent consumes inert declarations and substantive pure policy; portable private implementation never crosses layers (#613).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/agent/internal/" },
    },
    {
      name: "agent-interface-reexports-internal",
      severity: "error",
      comment:
        "Agent publication never launders Transcript, context, tool or lifecycle implementation (#613).",
      from: { path: "^cloudflare/(agent|agent/.+)/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/agent/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "agent-contract-imports-implementation",
      severity: "error",
      comment:
        "Agent declarations expose inert work and observations, never executable lifecycle implementation (#613).",
      from: { path: "^cloudflare/(agent|agent/.+)/contract\\.ts$" },
      to: { path: "^cloudflare/agent/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "agent-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Agent internals depend on declarations and siblings, never backwards on their own public runtime or operations (#613).",
      from: { path: "^cloudflare/agent/internal/" },
      to: { path: "^cloudflare/agent/(operations|runtime)\\.ts$" },
    },
    {
      name: "agent-operations-imports-runtime",
      severity: "error",
      comment:
        "Low-level Agent atomic composition stays independent of hosted runtime and canonical execution (#613).",
      from: { path: "^cloudflare/(agent|agent/.+)/operations\\.ts$" },
      to: { path: "^cloudflare/agent/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-agent-internal",
      severity: "error",
      comment:
        "Agent owns Transcript, context, tools, Compaction, delivery and lifecycle implementation; peers consume only published operations or runtime construction (#613).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/agent/" },
      to: { path: "^cloudflare/agent/internal/" },
    },
    {
      name: "foreign-module-imports-cloudflare-whatsapp-internal",
      severity: "error",
      comment:
        "WhatsApp owns replay, delivery, provider evidence and retention; peers use bounded published operations (#608).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/whatsapp/" },
      to: { path: "^cloudflare/whatsapp/internal/" },
    },
    {
      name: "cloudflare-imports-portable-whatsapp-internal",
      severity: "error",
      comment:
        "Native channel work uses authenticated portable operations, never Kapso adapters or private transcript projections (#608).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/shell/channels/whatsapp/internal/" },
    },
    {
      name: "tooling-imports-whatsapp-internal",
      severity: "error",
      comment:
        "Operational tools cannot acquire private Kapso transport, fixtures or delivery implementation (#608).",
      from: { path: "^(scripts|tools)/" },
      to: { path: "^src/shell/channels/whatsapp/internal/" },
    },
    {
      name: "whatsapp-interface-reexports-internal",
      severity: "error",
      comment:
        "WhatsApp publication declares bounded owner behavior without laundering private implementations (#608).",
      from: { path: "^cloudflare/whatsapp/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/whatsapp/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "whatsapp-contract-imports-implementation",
      severity: "error",
      comment:
        "WhatsApp declarations carry safe channel evidence, never transport or persistence implementation (#608).",
      from: { path: "^cloudflare/whatsapp/contract\\.ts$" },
      to: { path: "^cloudflare/whatsapp/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "whatsapp-internal-imports-outward-interface",
      severity: "error",
      comment:
        "WhatsApp internals depend inward on declarations, not outward on published operations or runtime (#608).",
      from: { path: "^cloudflare/whatsapp/internal/" },
      to: { path: "^cloudflare/whatsapp/(operations|runtime)\\.ts$" },
    },
    {
      name: "whatsapp-operations-imports-runtime",
      severity: "error",
      comment:
        "WhatsApp lifecycle operations cannot acquire Worker or queue construction authority (#608).",
      from: { path: "^cloudflare/whatsapp/operations\\.ts$" },
      to: { path: "^cloudflare/whatsapp/runtime\\.ts$" },
    },

    {
      name: "cloudflare-imports-portable-canonical-internal",
      severity: "error",
      comment:
        "Native execution consumes published canonical declarations and behavior, never private portable dispatch or registry assembly (#612).",
      from: { path: "^cloudflare/" },
      to: {
        path: "^src/shell/(canonical-operations|canonical-catalog|canonical-policy|authorization)/internal/",
      },
    },
    {
      name: "foreign-module-imports-cloudflare-canonical-internal",
      severity: "error",
      comment:
        "Canonical execution owns mutation units, batch dispatch, query registries and commit-trigger interpretation. Peers, tests and tools use its declarations or substantive published operations (#612).",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: "^cloudflare/canonical-operations/",
      },
      to: { path: "^cloudflare/canonical-operations/internal/" },
    },
    {
      name: "canonical-interface-reexports-internal",
      severity: "error",
      comment:
        "Canonical execution publishes complete behavior instead of laundering private registry or mutation-unit authority (#612).",
      from: {
        path: "^cloudflare/(canonical-operations|canonical-operations/.+)/(contract|operations|runtime)\\.ts$",
      },
      to: { path: "^cloudflare/$1/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "canonical-contract-imports-implementation",
      severity: "error",
      comment:
        "Canonical execution declarations remain independent of dispatch implementation and runtime construction (#612).",
      from: {
        path: "^cloudflare/(canonical-operations|canonical-operations/.+)/contract\\.ts$",
      },
      to: { path: "^cloudflare/$1/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "canonical-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Canonical execution internals depend on declarations and sibling implementation, never backwards on their published operations or runtime (#612).",
      from: { path: "^cloudflare/(canonical-operations|canonical-operations/.+)/internal/" },
      to: { path: "^cloudflare/$1/(operations|runtime)\\.ts$" },
    },
    {
      name: "canonical-operations-imports-runtime",
      severity: "error",
      comment:
        "Canonical execution operations do not acquire runtime construction authority (#612).",
      from: {
        path: "^cloudflare/(canonical-operations|canonical-operations/.+)/operations\\.ts$",
      },
      to: { path: "^cloudflare/$1/runtime\\.ts$" },
    },

    {
      name: "foreign-module-imports-cloudflare-ingestion-internal",
      severity: "error",
      comment:
        "Ingestion owns R2 material, outbox, parser finalization and retained rows. Peers use published admission and finalization operations (#605).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/ingestion/" },
      to: { path: "^cloudflare/ingestion/internal/" },
    },
    {
      name: "cloudflare-imports-portable-ingestion-internal",
      severity: "error",
      comment:
        "Native Ingestion consumes bounded portable operations; raw sample schemas, parser/provider implementation and format catalogs remain private (#605).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/ingestion/internal/" },
    },
    {
      name: "ingestion-interface-reexports-internal",
      severity: "error",
      comment:
        "Ingestion declares owner behavior without laundering private storage, parser or Workflow exports (#605).",
      from: { path: "^cloudflare/ingestion/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/ingestion/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "ingestion-contract-imports-implementation",
      severity: "error",
      comment:
        "Ingestion declarations carry bounded inputs and outcomes, never private implementation or runtime authority (#605).",
      from: { path: "^cloudflare/ingestion/contract\\.ts$" },
      to: { path: "^cloudflare/ingestion/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "ingestion-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Ingestion internals depend on declarations and sibling internals, never outward on their own published operations or runtime (#605).",
      from: { path: "^cloudflare/ingestion/internal/" },
      to: { path: "^cloudflare/ingestion/(operations|runtime)\\.ts$" },
    },
    {
      name: "ingestion-operations-imports-runtime",
      severity: "error",
      comment:
        "Ingestion admission and finalization operations do not acquire Worker/Workflow construction authority (#605).",
      from: { path: "^cloudflare/ingestion/operations\\.ts$" },
      to: { path: "^cloudflare/ingestion/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-onboarding-internal",
      severity: "error",
      comment: "Onboarding composition is private; callers consume its bounded operations (#611).",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: "^cloudflare/onboarding/",
      },
      to: { path: "^cloudflare/onboarding/internal/" },
    },
    {
      name: "onboarding-imports-unpublished-native-authority",
      severity: "error",
      comment:
        "The data-free coordinator invokes published owners; persistence and runtime authority stay private (#611).",
      from: { path: "^cloudflare/onboarding/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^cloudflare/",
        pathNot: [
          "^cloudflare/onboarding/",
          "^cloudflare/(consent|email-authentication|identity|recovery|secret-material)/(contract|operations)\\.ts$",
        ],
      },
    },
    {
      name: "onboarding-interface-reexports-internal",
      severity: "error",
      comment:
        "Onboarding publication declares behavior without laundering private composition (#611).",
      from: { path: "^cloudflare/onboarding/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/onboarding/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "onboarding-contract-imports-implementation",
      severity: "error",
      comment: "Onboarding declarations carry no native execution authority (#611).",
      from: { path: "^cloudflare/onboarding/contract\\.ts$" },
      to: { path: "^cloudflare/onboarding/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "onboarding-internal-imports-outward-interface",
      severity: "error",
      comment: "Private Onboarding execution depends inward on declarations (#611).",
      from: { path: "^cloudflare/onboarding/internal/" },
      to: { path: "^cloudflare/onboarding/(operations|runtime)\\.ts$" },
    },
    {
      name: "onboarding-operations-imports-runtime",
      severity: "error",
      comment: "Onboarding operations cannot acquire construction authority (#611).",
      from: { path: "^cloudflare/onboarding/operations\\.ts$" },
      to: { path: "^cloudflare/onboarding/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-web-authentication-internal",
      severity: "error",
      comment:
        "Web Authentication dispatch is private; callers consume its bounded operations (#610).",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: "^cloudflare/web-authentication/",
      },
      to: { path: "^cloudflare/web-authentication/internal/" },
    },
    {
      name: "web-authentication-imports-unpublished-native-authority",
      severity: "error",
      comment:
        "The data-free coordinator invokes published owners; persistence and runtime authority stay private (#610).",
      from: { path: "^cloudflare/web-authentication/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^cloudflare/",
        pathNot: [
          "^cloudflare/web-authentication/",
          "^cloudflare/(browser-login|email-authentication|onboarding|recovery|tokens|web-session)/(contract|operations)\\.ts$",
        ],
      },
    },
    {
      name: "web-authentication-interface-reexports-internal",
      severity: "error",
      comment:
        "Web Authentication publication declares behavior without laundering private dispatch (#610).",
      from: { path: "^cloudflare/web-authentication/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/web-authentication/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "web-authentication-contract-imports-implementation",
      severity: "error",
      comment: "Web Authentication declarations carry no native execution authority (#610).",
      from: { path: "^cloudflare/web-authentication/contract\\.ts$" },
      to: { path: "^cloudflare/web-authentication/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "web-authentication-internal-imports-outward-interface",
      severity: "error",
      comment: "Private Web Authentication execution depends inward on declarations (#610).",
      from: { path: "^cloudflare/web-authentication/internal/" },
      to: { path: "^cloudflare/web-authentication/(operations|runtime)\\.ts$" },
    },
    {
      name: "web-authentication-operations-imports-runtime",
      severity: "error",
      comment: "Web Authentication operations cannot acquire construction authority (#610).",
      from: { path: "^cloudflare/web-authentication/operations\\.ts$" },
      to: { path: "^cloudflare/web-authentication/runtime\\.ts$" },
    },
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
          "(^|.*/)node_modules/effect/(dist|src)/(http|http-api)(/|$)|" +
          "^(fs|http|https|net|os|child_process|stream|dns|tls|timers|cluster|worker_threads)(/|$)",
      },
    },
    {
      name: "core-slice-reaches-sibling-slice",
      severity: "error",
      comment:
        "A core slice imported a sibling's implementation instead of a published interface. " +
        "A core slice may import ownerless shared values from core/_shared or a sibling's direct " +
        "contract.ts or operations.ts, but sibling models, rules, errors, and other " +
        "implementation details remain private. Core decides, it does not gather " +
        "(ARCHITECTURE.md §2).",

      from: { path: "^src/core/([^/]+)/", pathNot: "^src/core/_shared/" },
      to: {
        path: "^src/core/[^/]+/",
        pathNot: [
          "^src/core/_shared/",
          "^src/core/$1/",
          "^src/core/[^/]+/(contract|operations)\\.ts$",
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
      name: "foreign-module-imports-cloudflare-recovery-internal",
      severity: "error",
      comment:
        "Recovery code material, support decisions and persistence remain owner-private (#601).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/recovery/" },
      to: { path: "^cloudflare/recovery/internal/" },
    },
    {
      name: "cloudflare-imports-portable-login-recovery-internal",
      severity: "error",
      comment:
        "Native Browser Login and Recovery consume published portable declarations and decisions (#601).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/(browser-login|recovery)/internal/" },
    },
    {
      name: "recovery-interface-reexports-internal",
      severity: "error",
      comment:
        "Recovery publication declares bounded behavior without laundering private code or case implementation (#601).",
      from: { path: "^cloudflare/recovery/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/recovery/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "login-recovery-contract-imports-implementation",
      severity: "error",
      comment:
        "Browser Login and Recovery declarations do not acquire proof or persistence implementation (#601).",
      from: { path: "^cloudflare/(browser-login|recovery)/contract\\.ts$" },
      to: { path: "^cloudflare/$1/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "login-recovery-internal-imports-outward-interface",
      severity: "error",
      comment: "Browser Login and Recovery implementation depends inward on declarations (#601).",
      from: { path: "^cloudflare/(browser-login|recovery)/internal/" },
      to: { path: "^cloudflare/$1/(operations|runtime)\\.ts$" },
    },
    {
      name: "login-recovery-operations-imports-runtime",
      severity: "error",
      comment:
        "Browser Login and Recovery operations do not acquire runtime construction authority (#601).",
      from: { path: "^cloudflare/(browser-login|recovery)/operations\\.ts$" },
      to: { path: "^cloudflare/$1/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-tokens-internal",
      severity: "error",
      comment:
        "Tokens PAT rows, pairing proofs, persistence and bearer verification remain owner-private (#602). Call its published contract, operations or runtime composition.",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/tokens/" },
      to: { path: "^cloudflare/tokens/internal/" },
    },
    {
      name: "cloudflare-imports-portable-tokens-internal",
      severity: "error",
      comment:
        "Native Tokens adapters consume published portable operations, never raw query or row internals (#602).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/tokens/internal/" },
    },
    {
      name: "tokens-interface-reexports-internal",
      severity: "error",
      comment:
        "Native Tokens publication declares behavior rather than laundering private proof or persistence implementation (#602).",
      from: { path: "^cloudflare/tokens/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/tokens/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "tokens-contract-imports-implementation",
      severity: "error",
      comment:
        "Tokens's native contract is independently readable and never acquires proof, persistence or lifecycle implementation (#602).",
      from: { path: "^cloudflare/tokens/contract\\.ts$" },
      to: { path: "^cloudflare/tokens/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "tokens-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Tokens internals depend inward on declarations, never on the outward operations or runtime interface (#602).",
      from: { path: "^cloudflare/tokens/internal/" },
      to: { path: "^cloudflare/tokens/(operations|runtime)\\.ts$" },
    },
    {
      name: "tokens-operations-imports-runtime",
      severity: "error",
      comment: "Tokens operations do not acquire runtime construction authority (#602).",
      from: { path: "^cloudflare/tokens/operations\\.ts$" },
      to: { path: "^cloudflare/tokens/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-email-authentication-internal",
      severity: "error",
      comment:
        "Email Authentication proof rows, enrollment, Resend and Workflows remain owner-private (#600). Call its published contract, operations or runtime composition.",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: "^cloudflare/email-authentication/",
      },
      to: { path: "^cloudflare/email-authentication/internal/" },
    },
    {
      name: "cloudflare-imports-portable-email-authentication-internal",
      severity: "error",
      comment:
        "Native Email Authentication adapters consume published portable operations, never raw query or row internals (#600).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/email-authentication/internal/" },
    },
    {
      name: "email-authentication-interface-reexports-internal",
      severity: "error",
      comment:
        "Native Email Authentication publication declares behavior rather than laundering private provider or persistence implementation (#600).",
      from: { path: "^cloudflare/email-authentication/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/email-authentication/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "email-authentication-contract-imports-implementation",
      severity: "error",
      comment:
        "Email Authentication's native contract is independently readable and never acquires provider, persistence or Workflow implementation (#600).",
      from: { path: "^cloudflare/email-authentication/contract\\.ts$" },
      to: { path: "^cloudflare/email-authentication/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "email-authentication-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Email Authentication internals depend inward on declarations, never on the outward operations or runtime interface (#600).",
      from: { path: "^cloudflare/email-authentication/internal/" },
      to: { path: "^cloudflare/email-authentication/(operations|runtime)\\.ts$" },
    },
    {
      name: "email-authentication-operations-imports-runtime",
      severity: "error",
      comment:
        "Email Authentication operations do not acquire Workflow construction authority (#600).",
      from: { path: "^cloudflare/email-authentication/operations\\.ts$" },
      to: { path: "^cloudflare/email-authentication/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-subscription-internal",
      severity: "error",
      comment:
        "Subscription billing rows, enrollment, Wompi and Workflows remain owner-private (#599). Call its published contract, operations or runtime composition.",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/subscription/" },
      to: { path: "^cloudflare/subscription/internal/" },
    },
    {
      name: "cloudflare-imports-portable-subscription-internal",
      severity: "error",
      comment:
        "Native Subscription adapters consume published portable operations, never raw query or row internals (#599).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/subscription/internal/" },
    },
    {
      name: "subscription-interface-reexports-internal",
      severity: "error",
      comment:
        "Native Subscription publication declares behavior rather than laundering private provider or persistence implementation (#599).",
      from: { path: "^cloudflare/subscription/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/subscription/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "subscription-contract-imports-implementation",
      severity: "error",
      comment:
        "Subscription's native contract is independently readable and never acquires provider, persistence or Workflow implementation (#599).",
      from: { path: "^cloudflare/subscription/contract\\.ts$" },
      to: { path: "^cloudflare/subscription/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "subscription-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Subscription internals depend inward on declarations, never on the outward operations or runtime interface (#599).",
      from: { path: "^cloudflare/subscription/internal/" },
      to: { path: "^cloudflare/subscription/(operations|runtime)\\.ts$" },
    },
    {
      name: "subscription-operations-imports-runtime",
      severity: "error",
      comment: "Subscription operations do not acquire Workflow construction authority (#599).",
      from: { path: "^cloudflare/subscription/operations\\.ts$" },
      to: { path: "^cloudflare/subscription/runtime\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-insights-internal",
      severity: "error",
      comment:
        "Insights owns scheduled occurrences, lifecycle and delivery evidence. Peers use published operations, never private SQL or rows (#606).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/insights/" },
      to: { path: "^cloudflare/insights/internal/" },
    },
    {
      name: "cloudflare-imports-portable-insights-internal",
      severity: "error",
      comment:
        "Native Insights consumes portable contracts and operations; core and shell internals remain private across the platform boundary (#606).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/insights/internal/" },
    },
    {
      name: "insights-interface-reexports-internal",
      severity: "error",
      comment:
        "Insights publishes substantive behavior and declarations, never re-exported private rows, SQL or projection mechanics (#606).",
      from: { path: "^cloudflare/insights/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/insights/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "insights-contract-imports-implementation",
      severity: "error",
      comment:
        "The native Insights contract declares semantic inputs and projections independently of implementation or runtime authority (#606).",
      from: { path: "^cloudflare/insights/contract\\.ts$" },
      to: { path: "^cloudflare/insights/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "insights-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Native Insights implementation depends on its contract and sibling internals, never backwards on its own outward behavior or runtime (#606).",
      from: { path: "^cloudflare/insights/internal/" },
      to: { path: "^cloudflare/insights/(operations|runtime)\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-dashboard-internal",
      severity: "error",
      comment:
        "Dashboard owns documents, layout and validated financial projections. Peers use published operations, never private SQL or rows (#604).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/dashboard/" },
      to: { path: "^cloudflare/dashboard/internal/" },
    },
    {
      name: "cloudflare-imports-portable-dashboard-internal",
      severity: "error",
      comment:
        "Native Dashboard consumes portable contracts and operations; core and shell internals remain private across the platform boundary (#604).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/dashboard/internal/" },
    },
    {
      name: "dashboard-interface-reexports-internal",
      severity: "error",
      comment:
        "Dashboard publishes substantive behavior and declarations, never re-exported private rows, SQL or projection mechanics (#604).",
      from: { path: "^cloudflare/dashboard/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/dashboard/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "dashboard-contract-imports-implementation",
      severity: "error",
      comment:
        "The native Dashboard contract declares semantic inputs and projections independently of implementation or runtime authority (#604).",
      from: { path: "^cloudflare/dashboard/contract\\.ts$" },
      to: { path: "^cloudflare/dashboard/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "dashboard-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Native Dashboard implementation depends on its contract and sibling internals, never backwards on its own outward behavior or runtime (#604).",
      from: { path: "^cloudflare/dashboard/internal/" },
      to: { path: "^cloudflare/dashboard/(operations|runtime)\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-budgets-internal",
      severity: "error",
      comment:
        "Budgets owns caps, exact monthly spending, alert latches and retained progress. Peers use published operations, never private SQL or rows (#603).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/budgets/" },
      to: { path: "^cloudflare/budgets/internal/" },
    },
    {
      name: "cloudflare-imports-portable-budgets-internal",
      severity: "error",
      comment:
        "Native Budgets consumes portable contracts and operations; core and shell internals remain private across the platform boundary (#603).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/budgets/internal/" },
    },
    {
      name: "budgets-interface-reexports-internal",
      severity: "error",
      comment:
        "Budgets publishes substantive behavior and declarations, never re-exported private rows, SQL or monthly calculations (#603).",
      from: { path: "^cloudflare/budgets/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/budgets/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "budgets-contract-imports-implementation",
      severity: "error",
      comment:
        "The native Budget contract declares semantic inputs and projections independently of implementation or runtime authority (#603).",
      from: { path: "^cloudflare/budgets/contract\\.ts$" },
      to: { path: "^cloudflare/budgets/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "budgets-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Native Budget implementation depends on its contract and sibling internals, never backwards on its own outward behavior or runtime (#603).",
      from: { path: "^cloudflare/budgets/internal/" },
      to: { path: "^cloudflare/budgets/(operations|runtime)\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-transactions-internal",
      severity: "error",
      comment:
        "Transactions owns capture, exact effective relations, corrections and retained provenance. Peers use published operations, never private SQL or rows (#598).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/transactions/" },
      to: { path: "^cloudflare/transactions/internal/" },
    },
    {
      name: "cloudflare-imports-portable-transactions-internal",
      severity: "error",
      comment:
        "Native Transactions consumes portable contracts and operations; core and shell internals remain private across the platform boundary (#598).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/transactions/internal/" },
    },
    {
      name: "transactions-interface-reexports-internal",
      severity: "error",
      comment:
        "Transactions publishes substantive behavior and declarations, never re-exported private rows, SQL or policy (#598).",
      from: { path: "^cloudflare/transactions/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/transactions/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "transactions-contract-imports-implementation",
      severity: "error",
      comment:
        "The native Transaction contract declares semantic inputs and projections independently of implementation or runtime authority (#598).",
      from: { path: "^cloudflare/transactions/contract\\.ts$" },
      to: { path: "^cloudflare/transactions/(internal/|operations\\.ts$|runtime\\.ts$)" },
    },
    {
      name: "transactions-internal-imports-outward-interface",
      severity: "error",
      comment:
        "Native Transaction implementation depends on its contract and sibling internals, never backwards on its own outward behavior or runtime (#598).",
      from: { path: "^cloudflare/transactions/internal/" },
      to: { path: "^cloudflare/transactions/(operations|runtime)\\.ts$" },
    },
    {
      name: "foreign-module-imports-cloudflare-categories-internal",
      severity: "error",
      comment:
        "Categories owns keyword persistence, matching policy and native query assembly. Other owners use its published operations (#597).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/categories/" },
      to: { path: "^cloudflare/categories/internal/" },
    },
    {
      name: "cloudflare-imports-portable-categories-internal",
      severity: "error",
      comment:
        "Native Categories consumes portable contracts and operations, never core or shell internals (#597).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/categories/internal/" },
    },
    {
      name: "categories-interface-reexports-internal",
      severity: "error",
      comment:
        "The Category owner declares its native public interface without re-exporting private persistence or policy.",
      from: { path: "^cloudflare/categories/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/categories/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "foreign-module-imports-cloudflare-web-session-internal",
      severity: "error",
      comment:
        "WebSession credentials, rows and lifecycle are private; use the published owner contract and operations (#596).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/web-session/" },
      to: { path: "^cloudflare/web-session/internal/" },
    },
    {
      name: "foreign-module-imports-cloudflare-browser-login-internal",
      severity: "error",
      comment:
        "BrowserLogin verifier handling and pairing rows stay private; callers use its published operations (#596).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/browser-login/" },
      to: { path: "^cloudflare/browser-login/internal/" },
    },
    {
      name: "cloudflare-imports-portable-web-session-internal",
      severity: "error",
      comment:
        "WebSession SQL policies stay private across the portable/Cloudflare boundary (#596).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/web-session/internal/" },
    },
    {
      name: "session-interface-reexports-internal",
      severity: "error",
      comment:
        "Session and pairing publication declares behavior without re-exporting private implementation (#596).",
      from: { path: "^cloudflare/(web-session|browser-login)/(contract|operations|runtime)\\.ts$" },
      to: { path: "^cloudflare/$1/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "foreign-module-imports-cloudflare-identity-internal",
      severity: "error",
      comment:
        "Identity's User rows, WhatsApp association and context projections are private. " +
        "Other adapters, portable modules, tests and tools use Identity contract.ts or operations.ts (#595).",
      from: { path: "^(src|cloudflare|scripts|tools)/", pathNot: "^cloudflare/identity/" },
      to: { path: "^cloudflare/identity/(internal/|user-context/internal/)" },
    },
    {
      name: "cloudflare-imports-portable-identity-internal",
      severity: "error",
      comment:
        "Cloudflare adapters consume Identity's published contract and operations; portable " +
        "Identity internals remain private across the platform boundary (#595, ADR 0003).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/identity/internal/" },
    },
    {
      name: "identity-interface-reexports-internal",
      severity: "error",
      comment:
        "Identity's published Cloudflare interfaces declare their behavior rather than re-exporting internals.",
      from: {
        path: "^cloudflare/(identity|identity/user-context)/(contract|operations|runtime)\\.ts$",
      },
      to: { path: "^cloudflare/$1/internal/", dependencyTypes: ["export"] },
    },
    {
      name: "foreign-module-imports-cloudflare-consent-internal",
      severity: "error",
      comment:
        "Consent's Cloudflare rows, SQL, and lifecycle implementation are private to that owner. " +
        "Other adapters, portable modules, tests, and tools must use Consent contract.ts, " +
        "operations.ts, or an explicit runtime composition instead (#594, ADR 0003).",
      from: {
        path: "^(src|cloudflare|scripts|tools)/",
        pathNot: "^cloudflare/consent/",
      },
      to: { path: "^cloudflare/consent/internal/" },
    },
    {
      name: "cloudflare-imports-portable-consent-internal",
      severity: "error",
      comment:
        "Cloudflare adapters, including the same-named Consent adapter, consume the portable " +
        "Consent owner's published contract and operations. Core and shell Consent internals " +
        "remain private across the platform boundary (#594, ADR 0003).",
      from: { path: "^cloudflare/" },
      to: { path: "^src/(core|shell)/consent/internal/" },
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
          "subscription/wompi-(billing-)?client\\.test\\.ts)$|^cloudflare/subscription/internal/wompi-(billing-)?client\\.test\\.ts$",
      },
      to: {
        path: "^(?:\\.\\./)*node_modules/effect/dist/http/index\\.js$",
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
        pathNot: ["/runtime\\.ts$"],
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
      name: "api-assembly-imports-beyond-operations",
      severity: "error",
      comment:
        "The canonical API landmark composes only published declaration contracts and its catalog. " +
        "It cannot acquire execution, registry, provider, storage or runtime authority. " +
        "Implementations depend on the assembled API, never the reverse (#612).",
      from: { path: "^src/shell/api\\.ts$" },
      to: {
        path: "^src/",
        pathNot: [
          "^src/shell/public-http/contract\\.ts$",
          "^src/shell/(identity|categories|transactions|subscription|budgets|dashboard|insights|recurring|email-authentication|tokens|browser-login|recovery|ingestion|memory|quotas|canonical-catalog|authorization|operations)/contract\\.ts$",
        ],
      },
    },
    {
      // The package-level facade is the only browser-facing source allowed to reach shell modules
      // from outside the server tree. The web package depends on `src/client.ts`; it must
      // not know whether the canonical declaration currently lives under shell/.
      name: "browser-client-seam-bypass",
      severity: "error",
      comment:
        "Code outside src/shell imported a server-internal shell module directly. The browser " +
        "depends on the package-level client facade (`src/client.ts` / `@fidy/server/client`), " +
        "which preserves one canonical API without making shell paths public.",
      from: {
        path: "^src/",
        pathNot: ["^src/shell/", "^src/client\\.ts$"],
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
          "^src/shell/agent/contract\\.ts$",
          "^src/shell/authorization/runtime\\.ts$",
          "^src/shell/canonical-operations/contract\\.ts$",
          "^src/shell/canonical-policy/operations\\.ts$",
          // Canonical ordered-batch schemas and pure child projection, with no execution authority (#971).
          "^src/shell/operations/contract\\.ts$",
          "^src/shell/(oauth-agents|public-http|quotas|schema-codecs|tokens|subscription|web-authentication)/contract\\.ts$",
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
        path: "^src/shell/(agent/(contract\\.ts|__probe-.*hosted-(provider|model|tokenizer|js-tokenizer)/probe\\.ts)|memory/(operations\\.ts|__probe-.*hosted-(provider|model|tokenizer|js-tokenizer)/probe\\.ts)|hosted-inference/(contract|operations)\\.ts)$",
      },
      to: {
        path: "(^|.*/)node_modules/effect/.*/ai/(index|LanguageModel|Tokenizer)",
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
      from: { path: "^(src|cloudflare|scripts|tools)/" },
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
        "imports are aliased (`~/core/transactions/contract`), so a crossing is visible as one " +
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
    tsConfig: { fileName: "tsconfig.dependencies.json" },
    // Type-only imports are still edges: `import type { TransactionFailure }`
    // is core knowledge reaching shell, and erasing at compile time does not
    // make it less of an architectural arrow.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
