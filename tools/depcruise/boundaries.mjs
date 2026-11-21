import { dirname, relative, resolve } from "node:path";

const trio = /\/(contract|operations|runtime)\.ts$/u;

const serverModule = /^(?:src\/(?:core|shell)|cloudflare)\//u;

const sharedKernel = /^src\/core\/_shared\/(?:money|context|time)\.ts$/u;

const testSource = /(?:\.(?:test|spec|fixture)|\.test-fixture)\.[cm]?[jt]sx?$/u;

const compositionRoots = new Set([
  "cloudflare/recovery/support-recovery.test.ts",
  "../cli/src/direct-client/runtime.ts",
  "../cli/test/direct-client/resources.test.ts",
  "../web/src/transport/browser-http-policy.ts",
  "../web/test/transport/client.node.test.ts",
  "../../scripts/pro/runtime.ts",
  "src/client.ts",
  "src/browser-bootstrap.ts",
  "src/browser-http.ts",
  "src/browser-transport.ts",
  "test/shell/memory/memory-policy.test.ts",
  "cloudflare/core-worker.ts",
  "cloudflare/release-smoke-worker.ts",
  "cloudflare/public-worker.ts",
  "cloudflare/operational-canary-workflow.ts",
  "cloudflare/ingestion/email-worker.ts",
  "cloudflare/ai/openai-conformance-worker.ts",
  "cloudflare/ai/openai-evaluation-worker.ts",
  "cloudflare/categories/taxonomy.test-fixture.ts",
  "cloudflare/queue/failure-isolation.test.ts",
  "tools/email-formats/generate-runtime.ts",
  "cloudflare/maintenance/monitoring-isolation.test.ts",
  "cloudflare/budgets/budgets.test.ts",
  "cloudflare/consent/browser.test.ts",
  "cloudflare/categories/keyword-rules.test.ts",
  "cloudflare/memory/memory.test.ts",
  "cloudflare/onboarding/consent-ingress.test.ts",
  "cloudflare/transactions/transactions.test.ts",
]);

const testRunner = new Set([
  "cloudflare/vitest.config.ts",
  "cloudflare/test-sequencer.ts",
  "cloudflare/test-shards.ts",
  "cloudflare/test-shards.test.ts",
]);

const sharedTestSupport = new Set([
  "../../scripts/dev-browser-api.ts",
  "cloudflare/signed-whatsapp.test-fixture.ts",
  "cloudflare/openai.test-fixture.ts",
  "src/shell/testing/credential-evidence-harness.ts",
  "src/shell/testing/crypto-harness.ts",
  "test/support/outbound-http.ts",
  "cloudflare/user-store.test-fixture.ts",
  "cloudflare/financial-user-store.test-fixture.ts",
  "cloudflare/erasure-purge.test-fixture.ts",
  "cloudflare/browser-bootstrap.test-fixture.ts",
  "cloudflare/workflow-test-runtime.ts",
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
    const mirroredSource = /^test\/((?:core|shell)\/.+)$/u.exec(path)?.[1];

    if (mirroredSource !== undefined) return owner(`src/${mirroredSource}`);

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
      !to.endsWith("/contract.ts") &&
      !(
        from === "src/shell/observability/contract.ts" &&
        to === "src/shell/observability/canonical-metadata.generated.json"
      ),
  },
];

const recoveryWorker = new Map([
  ["cloudflare/fixture-fallback-core.ts", "cloudflare/core-worker.ts"],
  ["cloudflare/fixture-fallback-ingress.ts", "cloudflare/public-worker.ts"],
]);

/** @param {Edge} edge - Resolved architectural dependency. */
const isSharedComposition = ({ from, to }) =>
  recoveryWorker.get(from) === to ||
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
export const boundaryViolations = (report, packageRoot) => {
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

        return [...directionRules, ...boundaryRules].flatMap(({ name, reason, rejects }) =>
          rejects(edge) ? [{ name, reason, from, to }] : []
        );
      });
    });
};
