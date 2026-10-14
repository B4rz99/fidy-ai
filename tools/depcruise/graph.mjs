import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

/** @param {string} packageRoot - Application root. @param {string} directory - Repository source directory; dependencies are not graph roots. @returns {string[]} */
const sourceFiles = (packageRoot, directory) =>
  readdirSync(resolve(packageRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : sourceFiles(packageRoot, path);
    }
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
/** @param {string} packageRoot - Application root. @param {string[]} roots - Requested source inputs. */
const graphSources = (packageRoot, roots) => {
  if (roots.length === 0) return ["src"];
  if (
    !packageRoot.endsWith("/apps/server") ||
    !roots.includes("src") ||
    !roots.includes("cloudflare")
  ) {
    return roots;
  }
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
  return [...roots, ...repositorySources];
};

/** @param {import("dependency-cruiser").ICruiseResult} report - A green graph must have inspected source. */
const assertCruisedSomething = (report) => {
  if (report.summary.totalCruised === 0) {
    throw new Error(
      "dependency-cruiser cruised 0 modules; install tools/depcruise with its classic TypeScript compiler API"
    );
  }
};

/** @param {import("dependency-cruiser").ICruiseResult} graph - Complete graph. @param {string} packageRoot - Application root. @param {string[]} sourceRoots - Requested inputs. */
const assertCompleteGraph = (graph, packageRoot, sourceRoots) => {
  const sources = new Set(graph.modules.map(({ source }) => resolve(packageRoot, source)));
  const requested = sourceRoots.flatMap((root) =>
    statSync(resolve(packageRoot, root)).isDirectory() ? sourceFiles(packageRoot, root) : [root]
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

/** @param {string} directory - Application root. @param {string[]} roots - Source inputs. @param {boolean} [validate] - Run import rules as well as resolution. */
export const loadGraph = async (directory, roots, validate = true) => {
  const packageRoot = resolve(directory);
  const sourceRoots = graphSources(packageRoot, roots);
  const ruleSet = await extractDepcruiseConfig(resolve(packageRoot, ".dependency-cruiser.mjs"));
  const fileName = ruleSet.options?.tsConfig?.fileName;
  if (fileName === undefined || ruleSet.forbidden === undefined) {
    throw new Error("dependency-cruiser requires a TypeScript config and forbidden rules");
  }
  const tsConfig = extractTSConfig(resolve(packageRoot, fileName));
  // Reported paths and rule patterns are application-relative.
  const previousDirectory = process.cwd();
  process.chdir(packageRoot);
  try {
    const { output } = await cruise(sourceRoots, { ruleSet, validate }, undefined, { tsConfig });
    if (typeof output === "string") throw new Error("Expected a dependency-cruiser graph object");
    assertCruisedSomething(output);
    assertCompleteGraph(output, packageRoot, sourceRoots);
    const unresolved = unresolvedDependencies(output);
    if (unresolved.length > 0) {
      throw new Error(
        unresolved.map(({ from, to }) => `unresolved-dependency: ${from} → ${to}`).join("\n")
      );
    }
    return { packageRoot, report: output, forbiddenRules: ruleSet.forbidden };
  } finally {
    process.chdir(previousDirectory);
  }
};
