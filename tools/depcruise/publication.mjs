// Resolved ownership, rather than a migration list, closes every present and future server module.
import { dirname, relative, resolve } from "node:path";

const trio = /\/(contract|operations|runtime)\.ts$/u;
const serverModule = /^(?:src\/(?:core|shell)|cloudflare)\//u;
const sharedKernel = /^src\/core\/_shared\/(?:money|context|time)\.ts$/u;
const testSource = /(?:\.(?:test|spec|fixture)|\.test-fixture)\.[cm]?[jt]sx?$/u;

// These are application entrypoints, not owner implementations or an escape for a filename suffix.
const compositionRoots = new Set([
  "src/client.ts",
  "cloudflare/core-worker.ts",
  // Native scheduler journeys share private object transport while retaining real owner D1 work.
  // The test-support direction rule still forbids every production import of this composition.
  "cloudflare/core-worker.test-fixture.ts",
  "cloudflare/public-worker.ts",
  "cloudflare/operational-canary-workflow.ts",
  "cloudflare/ingestion/email-worker.ts",
  "cloudflare/ai/workers-ai-conformance-worker.ts",
  "cloudflare/coordinator-test-harness.ts",
  "cloudflare/browser-acceptance-core-module.ts",
  "cloudflare/browser-acceptance-preview.ts",
  "cloudflare/browser-acceptance-whatsapp.ts",
  "cloudflare/resource-admission/resource-admission-worker.fixture.ts",
  "cloudflare/browser-acceptance-core-bundle.d.mts",
  "cloudflare/browser-acceptance-core-bundle.mjs",
  "tools/email-formats/generate-runtime.ts",
  // These suites construct real cross-owner D1/DO/Workflow compositions. Ordinary owner tests
  // have no such role; a new broad composition must be named and reviewed here.
  "cloudflare/maintenance/admission-retention.test.ts",
  // Fault injection runs the actual Core maintenance composition against an isolated D1.
  "cloudflare/maintenance/monitoring-isolation.test.ts",
  "cloudflare/agent/hosted-turn.test.ts",
  "cloudflare/budgets/budgets.test.ts",
  "cloudflare/connections/connections.test.ts",
  "cloudflare/categories/keyword-rules.test.ts",
  "cloudflare/dashboard/dashboard.test.ts",
  "cloudflare/email-authentication/retention.test.ts",
  "cloudflare/ingestion/forwarded-email.test.ts",
  "cloudflare/ingestion/statement-ingestion.test.ts",
  "cloudflare/insights/insight-store.test.ts",
  // WeeklySummary integration composes real Consent, Identity, Transactions, Insights,
  // channel claims and Agent Transcript owners; no production module imports this fixture.
  "cloudflare/weekly-summary.test-fixture.ts",
  // Budget/reminder integration composes real migrated Identity/Consent/Insights standing;
  // each run owns an isolated database, and production cannot import this fixture.
  "cloudflare/proactivity.test-fixture.ts",
  "cloudflare/agent/proactive-transcript.test.ts",
  "cloudflare/whatsapp/insight-delivery.test.ts",
  "cloudflare/recurring/recurring.test-fixture.ts",
  "cloudflare/memory/memory.test.ts",
  "cloudflare/onboarding/consent-ingress.test.ts",
  "cloudflare/onboarding/browser-authentication.test.ts",
  // Native chat ingress, provider approval and Consent expiry compose real owner runtimes.
  "cloudflare/provider-authentication/whatsapp.test.ts",
  // Real public/Core proof routing and protected standing share the enrollment D1/Workflow.
  "cloudflare/subscription/payment-enrollment.test.ts",
  // Public/Core billing-support proof verifies the independent operator authority boundary.
  "cloudflare/subscription/refund-support.test.ts",
  // Correction isolation constructs the actual User coordinator with migrated D1 persistence.
  "cloudflare/subscription/refunds.test.ts",
  "cloudflare/tokens/pats.test.ts",
  // OAuth suites compose real public/Core ingress, canonical owners and User coordination.
  "cloudflare/oauth-agents/oauth-ingress.test-fixture.ts",
  "cloudflare/oauth-agents/oauth-ingress.test.ts",
  "cloudflare/oauth-agents/oauth-confirmation.test.ts",
  "cloudflare/oauth-agents/oauth-canonical.test.ts",
  "cloudflare/oauth-agents/oauth-allowance.test.ts",
  "cloudflare/oauth-agents/oauth-management.test.ts",
  "cloudflare/oauth-agents/oauth-refresh.test.ts",
  "cloudflare/oauth-agents/oauth-discovery.test.ts",
  "cloudflare/oauth-agents/oauth-native-residency.test.ts",
  "cloudflare/transactions/transactions.test.ts",
  "cloudflare/audit/internal/audit.test.ts",
  // Real predecessor upgrade and mixed browser/PAT/hosted Audit observation.
  "cloudflare/audit/internal/reminder-audit-migration.test.ts",
  // Installed canonical/hosted reminder calls plus published attributable Audit observation.
  "cloudflare/insights/reminder-canonical.test.ts",
]);
const testRunner = new Set([
  "cloudflare/vitest.config.ts",
  "cloudflare/test-sequencer.ts",
  "cloudflare/test-shards.ts",
  "cloudflare/test-shards.test.ts",
]);
const sharedTestSupport = new Set([
  "src/shell/testing/credential-evidence-harness.ts",
  "src/shell/testing/crypto-harness.ts",
  "src/shell/outbound-http/testing.ts",
  "cloudflare/d1-test-fixture.ts",
  "cloudflare/d1-migration-test-worker.fixture.ts",
  "cloudflare/coordinator-test-harness.ts",
  "cloudflare/workflow-test-runtime.ts",
  "cloudflare/browser-acceptance-core-module.ts",
  "cloudflare/browser-acceptance-preview.ts",
  "cloudflare/browser-acceptance-whatsapp.ts",
  "cloudflare/browser-acceptance-seed.ts",
  "cloudflare/browser-acceptance-wompi.ts",
  "cloudflare/browser-acceptance-core-bundle.d.mts",
  "cloudflare/browser-acceptance-core-bundle.mjs",
]);

/** @param {string} path - Every registered harness and fixture is test-only, independently of its composition role. */
const isTestSupport = (path) =>
  testSource.test(path) || sharedTestSupport.has(path) || testRunner.has(path);

/** @param {string} source - Resolved graph module. @param {string} packageRoot - Graph cwd. */
export const serverPath = (source, packageRoot) =>
  relative(packageRoot, resolve(packageRoot, source)).replaceAll("\\", "/");

/** @param {string} path - Server-relative module path. */
const defaultOwner = (path) => {
  const match = /^(src\/(?:core|shell)\/(?:channels\/)?[^/]+|cloudflare\/[^/]+)\//u.exec(path);
  return match?.[1];
};

/** @param {readonly string[]} modules - All resolved modules. */
export const ownership = (modules) => {
  const named = new Set(
    modules
      .filter((path) => serverModule.test(path) && !path.includes("/internal/") && trio.test(path))
      .map(dirname)
  );
  /** @param {string} path - Server-relative module path. */
  const owner = (path) => {
    if (!serverModule.test(path)) return undefined;
    let candidate = dirname(path);
    while (candidate !== ".") {
      if (named.has(candidate)) return candidate;
      candidate = dirname(candidate);
    }
    return defaultOwner(path);
  };
  return owner;
};

/** @typedef {{name: string, from: string, to: string, reason: string}} PublicationViolation */

/** @typedef {{ source: string, dependencies: readonly { resolved: string }[] }} GraphModule */
/** @typedef {{ modules: readonly GraphModule[] }} Graph */
/** @typedef {ReturnType<typeof ownership>} OwnerOf */
/** @typedef {{from: string, to: string, sameOwner: boolean, composition: boolean, published: boolean}} Edge */
/** @typedef {{name: string, reason: string, rejects: (edge: Edge) => boolean}} Rule */

/** @type {readonly Rule[]} */
const directionRules = [
  {
    name: "production-imports-test-code",
    reason:
      "Test code and fixtures never become production authority, even through an approved application composition.",
    rejects: ({ from, to }) => isTestSupport(to) && !isTestSupport(from),
  },
  {
    name: "portable-imports-platform",
    reason:
      "Portable core and shell never import a Cloudflare implementation; native adapters depend on portable declarations and behavior.",
    rejects: ({ from, to }) => /^src\/(?:core|shell)\//u.test(from) && /^cloudflare[/:]/u.test(to),
  },
  {
    name: "core-imports-platform",
    reason:
      "The functional core knows no shell, platform or runtime composition, including through type-only edges.",
    rejects: ({ from, to }) => from.startsWith("src/core/") && !to.startsWith("src/core/"),
  },
  {
    name: "internal-imports-outward-interface",
    reason:
      "Private implementation depends on declarations and sibling internals, never its own outward operations or runtime.",
    rejects: ({ from, to, sameOwner }) =>
      sameOwner && /\/internal\//u.test(from) && /\/(operations|runtime)\.ts$/u.test(to),
  },
  {
    name: "operations-imports-runtime",
    reason: "Substantive behavior cannot reacquire its own construction authority.",
    rejects: ({ from, to, sameOwner }) =>
      sameOwner && from.endsWith("/operations.ts") && to.endsWith("/runtime.ts"),
  },
  {
    name: "contract-imports-implementation",
    reason:
      "Published declarations depend only on declarations, API assembly and the exact pure Shared Kernel, never behavior, storage or construction authority.",
    rejects: ({ from, to }) =>
      from.endsWith("/contract.ts") &&
      to !== "cloudflare:workers" &&
      to !== "src/shell/api.ts" &&
      !sharedKernel.test(to) &&
      !to.endsWith("/contract.ts"),
  },
];

/** @param {Edge} edge - Resolved architectural dependency. */
const isSharedComposition = ({ from, to }) =>
  (sharedTestSupport.has(to) && (testSource.test(from) || sharedTestSupport.has(from))) ||
  (compositionRoots.has(to) &&
    (compositionRoots.has(from) || testSource.test(from) || sharedTestSupport.has(from)));

/** @param {Edge} edge - Resolved architectural dependency. */
const publishedEdge = (edge) =>
  edge.to === "cloudflare:workers" ||
  edge.sameOwner ||
  sharedKernel.test(edge.to) ||
  (testRunner.has(edge.from) && testRunner.has(edge.to)) ||
  isSharedComposition(edge) ||
  (edge.to === "src/shell/api.ts" && !edge.from.startsWith("src/core/"));

/** @type {readonly Rule[]} */
const boundaryRules = [
  {
    name: "published-only",
    reason:
      "Cross-module dependencies target an earned contract.ts or operations.ts, or runtime.ts at a composition role. Private files and compatibility paths are never a foreign interface.",
    rejects: (edge) => !publishedEdge(edge) && !edge.published,
  },
  {
    name: "runtime-outside-composition",
    reason:
      "Foreign construction authority belongs to an earned runtime.ts or an explicitly named application/test composition, never ordinary calls or an arbitrary harness filename.",
    rejects: (edge) =>
      !publishedEdge(edge) &&
      edge.published &&
      edge.to.endsWith("/runtime.ts") &&
      !edge.composition,
  },
];

/**
 * @param {Map<string, GraphModule>} modules - Complete modules.
 * @param {OwnerOf} owner - Resolved module ownership.
 * @param {string} packageRoot - Graph cwd.
 */
const privateReachability = (modules, owner, packageRoot) => {
  /** @param {string} start - Published interface. */
  const reachable = (start) => {
    const visited = new Set([start]);
    const pending = [start];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined) continue;
      const targets = (modules.get(path)?.dependencies ?? []).map((dependency) =>
        serverPath(dependency.resolved, packageRoot)
      );
      const next = targets.filter(
        (target) => owner(target) === owner(start) && !visited.has(target)
      );
      for (const target of next) visited.add(target);
      pending.push(...next);
    }
    return [...visited];
  };
  const paths = [...modules.keys()].filter((path) => owner(path) === dirname(path));
  const runtime = new Set(paths.filter((path) => path.endsWith("/runtime.ts")).flatMap(reachable));
  const ordinary = new Set(
    paths.filter((path) => /\/(contract|operations)\.ts$/u.test(path)).flatMap(reachable)
  );
  return { runtime, ordinary };
};

/**
 * @param {Graph} report - Complete resolved graph.
 * @param {string} packageRoot - Graph cwd.
 * @returns {PublicationViolation[]} All publication violations, including type-only edges.
 */
export const publicationViolations = (report, packageRoot) => {
  const modules = new Map(
    report.modules.map((module) => [serverPath(module.source, packageRoot), module])
  );
  const owner = ownership([...modules.keys()]);
  const reachable = privateReachability(modules, owner, packageRoot);
  return [...modules]
    .filter(([path]) => !path.includes("node_modules/"))
    .flatMap(([from, module]) => {
      const composition =
        (from.endsWith("/runtime.ts") && owner(from) === dirname(from)) ||
        compositionRoots.has(from) ||
        (reachable.runtime.has(from) && !reachable.ordinary.has(from));
      const targets = module.dependencies
        .map((dependency) => serverPath(dependency.resolved, packageRoot))
        .filter(
          (to) =>
            serverModule.test(to) ||
            to === "cloudflare:workers" ||
            (owner(from) !== undefined &&
              /\.[cm]?[jt]sx?$/u.test(to) &&
              !to.includes("node_modules/"))
        );
      return targets.flatMap((to) => {
        const edge = {
          from,
          to,
          composition,
          sameOwner: owner(from) !== undefined && owner(from) === owner(to),
          published: trio.test(to) && owner(to) === dirname(to),
        };
        return [...directionRules, ...boundaryRules]
          .filter((rule) => rule.rejects(edge))
          .map(({ name, reason }) => ({ name, reason, from, to }));
      });
    });
};
