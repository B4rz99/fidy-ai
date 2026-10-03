// Runs the module-graph gate defined in the current package's `.dependency-cruiser.mjs`.
//
// Not the `depcruise` binary, for two reasons. The cruiser reads .ts sources
// and the tsconfig `paths` aliases through the classic TypeScript compiler API,
// which the root's Effect tsgo `typescript` build does not expose — so it is
// resolved from this directory's isolated install, the same arrangement
// tools/mutation uses and for the same reason. And when that API is missing the
// cruiser does not fail: it cruises zero modules, reports no violations and
// exits 0. A gate that enforces nothing while looking green is the exact
// failure this repo already had once, so `assertCruisedSomething` below turns
// it into an error.

import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { publicationViolations } from "./publication.mjs";
import { launderingViolations } from "./laundering.mjs";

const packageRoot = resolve(process.argv[2] ?? process.cwd());
const graphRoots = process.argv.slice(3);
const sourceRoots = graphRoots.length > 0 ? graphRoots : ["src"];
const repositoryConsumers =
  packageRoot.endsWith("/apps/server") &&
  sourceRoots.includes("src") &&
  sourceRoots.includes("cloudflare");
/** @param {string} directory - Repository source directory; dependencies are not graph roots. @returns {string[]} */
const sourceFiles = (directory) =>
  readdirSync(resolve(packageRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(path);
    }
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
if (repositoryConsumers) {
  // Git includes every application and repository source file, including root configurations and
  // untracked probes. The checked-in upstream reference checkouts are not product source; ignored
  // generated output and installed dependencies also never become independent graph roots.
  const repositorySources = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "../..",
      ":(top,exclude).repos/**",
    ],
    { cwd: packageRoot, encoding: "utf8" }
  )
    .split("\0")
    .filter((path) => /\.[cm]?[jt]sx?$/u.test(path) && existsSync(resolve(packageRoot, path)));
  sourceRoots.push(...repositorySources);
}

// The cruiser resolves every path against the cwd, and the reported module
// names are what the rule patterns match, so both must be package-root-relative.
process.chdir(packageRoot);

const ruleSet = await extractDepcruiseConfig(resolve(packageRoot, ".dependency-cruiser.mjs"));
const tsConfigFileName = ruleSet.options?.tsConfig?.fileName;
if (tsConfigFileName === undefined || ruleSet.forbidden === undefined) {
  throw new Error("dependency-cruiser requires a TypeScript config and forbidden rules");
}
const forbiddenRules = ruleSet.forbidden;
const tsConfig = extractTSConfig(resolve(packageRoot, tsConfigFileName));

/** @param {import("dependency-cruiser").ICruiseOptions} options - Cruise validation options. */
const cruiseSource = (options) =>
  cruise(sourceRoots, { ruleSet, ...options }, undefined, { tsConfig });

/** @param {import("dependency-cruiser").ICruiseOptions} options - Cruise validation options. */
const cruiseReport = async (options) => {
  // Without a reporter, dependency-cruiser returns its typed graph object directly.
  const { output } = await cruiseSource(options);
  if (typeof output === "string") throw new Error("Expected a dependency-cruiser graph object");
  return output;
};

/**
 * The tripwire. A cruise that found no modules cannot have found a violation
 * either, so a green run means nothing until this has passed.
 */
/** @param {import("dependency-cruiser").ICruiseResult} report - Cruised module graph. */
const assertCruisedSomething = (report) => {
  if (report.summary.totalCruised > 0) return;
  console.error(
    "dependency-cruiser cruised 0 modules, so none of its rules ran. This is what it does " +
      "when it cannot find a classic TypeScript compiler: check that tools/depcruise has its " +
      "own node_modules (`bun install` in that directory) and that the typescript pinned " +
      "there is the classic build, not the root's tsgo one."
  );
  process.exit(1);
};

// The reason lives on the rule in the config, not on the violation, so it has
// to be looked back up — and a rule whose message did not travel with it is a
// rule nobody can act on. Every rule in the config carries a `comment`, so a
// missing one is a bug in the config rather than a violation to print bare.
/** @param {string} ruleName - Name of a graph rule. */
const ruleReason = (ruleName) => {
  const rule = forbiddenRules.find((candidate) => candidate.name === ruleName);
  if (typeof rule?.comment === "string" && rule.comment.length > 0) return rule.comment;
  console.error(
    `The rule "${ruleName}" fired and has no \`comment\` in .dependency-cruiser.mjs. The ` +
      `comment is the whole message a developer gets, so a rule without one reports a ` +
      `violation nobody can act on. Give it one that explains the reason rather than ` +
      `restating the pattern.`
  );
  process.exit(1);
};

/** @param {string} path - Package-relative module path. */
const displayPath = (path) => path.replace(/^(?:\.\.\/)+node_modules\//u, "node_modules/");

/** @param {string} target - Resolved module path to inspect. */
const nestedInternalOwner = (target) => {
  const match = /^src\/(core|shell)\/(.+)\/internal\//u.exec(target);
  if (match === null) return undefined;
  const [, layer, modulePath] = match;
  if (layer === undefined || modulePath === undefined) {
    throw new Error(`Invalid internal module path: ${target}`);
  }
  return modulePath.includes("/") ? `src/${layer}/${modulePath}` : undefined;
};

/** @param {import("dependency-cruiser").ICruiseResult} report - Cruised module graph. */
const reportNestedForeignInternals = (report) => {
  let violations = 0;
  for (const module of report.modules) {
    for (const dependency of module.dependencies) {
      const target = dependency.resolved;
      if (typeof target !== "string") continue;
      const owner = nestedInternalOwner(target);
      if (owner === undefined || module.source.startsWith(`${owner}/`)) continue;
      violations += 1;
      console.error(`error foreign-module-imports-internal: ${module.source} → ${target}`);
      console.error(`  ${ruleReason("foreign-module-imports-internal")}\n`);
    }
  }
  return violations;
};

/** @param {import("dependency-cruiser").ICruiseResult} report - Cruised module graph. */
const reportViolations = (report) => {
  for (const violation of report.summary.violations) {
    const path = violation.cycle
      ? [
          displayPath(violation.from),
          ...violation.cycle.map((step) => displayPath(step.name)),
        ].join(" → ")
      : `${displayPath(violation.from)} → ${displayPath(violation.to)}`;
    console.error(`${violation.rule.severity} ${violation.rule.name}: ${path}`);
    console.error(`  ${ruleReason(violation.rule.name)}\n`);
  }

  if (report.summary.error > 0) {
    console.error(
      `${report.summary.error} module-graph violation(s). The rules and their reasoning are ` +
        `in .dependency-cruiser.mjs.`
    );
    process.exit(1);
  }
};

/** @param {import("dependency-cruiser").ICruiseResult} graph - Complete graph, not just a nonempty sample. */
const assertCompleteGraph = (graph) => {
  const sources = new Set(graph.modules.map(({ source }) => resolve(packageRoot, source)));
  const requested = sourceRoots.flatMap((root) =>
    statSync(resolve(packageRoot, root)).isDirectory() ? sourceFiles(root) : [root]
  );
  const missing = requested.filter((path) => !sources.has(resolve(packageRoot, path)));
  if (missing.length > 0) {
    throw new Error(`dependency-cruiser omitted source inputs: ${missing.join(", ")}`);
  }
};

/** @param {import("dependency-cruiser").ICruiseResult} graph - Resolved imports. */
const unresolvedDependencies = (graph) =>
  graph.modules.flatMap((module) =>
    module.dependencies
      .filter(
        (dependency) =>
          dependency.couldNotResolve &&
          dependency.module !== "cloudflare:workers" &&
          !(
            module.source === "cloudflare/browser-acceptance-core-module.ts" &&
            dependency.module === "./browser-acceptance-core-bundle.mjs"
          )
      )
      .map((dependency) => ({ from: module.source, to: dependency.module }))
  );

const report = await cruiseReport({ validate: true });
assertCruisedSomething(report);
assertCompleteGraph(report);
const unresolved = unresolvedDependencies(report);
for (const { from, to } of unresolved) {
  console.error(`error unresolved-dependency: ${from} → ${to}`);
}
const laundered = launderingViolations(report, packageRoot);
for (const violation of laundered) {
  console.error(`error ${violation.name}: ${violation.from} → ${violation.to}`);
  console.error(`  ${violation.reason}\n`);
}
const nestedForeignInternals = reportNestedForeignInternals(report);
const publications = packageRoot.endsWith("/apps/server")
  ? publicationViolations(report, packageRoot)
  : [];
for (const violation of publications) {
  console.error(`error ${violation.name}: ${violation.from} → ${violation.to}`);
  console.error(`  ${violation.reason}\n`);
}
reportViolations(report);
if (laundered.length + nestedForeignInternals + publications.length + unresolved.length > 0) {
  process.exit(1);
}

console.log(
  `module graph clean: ${report.summary.totalCruised} modules, ` +
    `${report.summary.totalDependenciesCruised} dependencies.`
);
