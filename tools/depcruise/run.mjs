// Runs the module-graph gate defined in `.dependency-cruiser.mjs`, and keeps
// ARCHITECTURE.md's dependency graph generated from the same cruise.
//
//   bun tools/depcruise/run.mjs           validate the rules, check the graph
//   bun tools/depcruise/run.mjs --write   regenerate the graph in place
//
// Not the `depcruise` binary, for two reasons. The cruiser reads .ts sources
// and the tsconfig `paths` aliases through the classic TypeScript compiler API,
// which the root's Effect tsgo `typescript` build does not expose — so it is
// resolved from this directory's isolated install, the same arrangement
// tools/crap uses and for the same reason. And when that API is missing the
// cruiser does not fail: it cruises zero modules, reports no violations and
// exits 0. A gate that enforces nothing while looking green is the exact
// failure this repo already had once, so `assertCruisedSomething` below turns
// it into an error.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const architectureFile = resolve(repoRoot, "ARCHITECTURE.md");

// The cruiser resolves every path against the cwd, and the reported module
// names are what the rule patterns match, so both must be repo-root-relative.
process.chdir(repoRoot);

const ruleSet = await extractDepcruiseConfig(resolve(repoRoot, ".dependency-cruiser.mjs"));
const tsConfig = extractTSConfig(ruleSet.options.tsConfig.fileName);

const cruiseSource = (options) => cruise(["src"], { ruleSet, ...options }, null, { tsConfig });

const cruiseReport = async (options) =>
  JSON.parse((await cruiseSource({ outputType: "json", ...options })).output);

/**
 * The tripwire. A cruise that found no modules cannot have found a violation
 * either, so a green run means nothing until this has passed.
 */
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
const ruleReason = (ruleName) => {
  const rule = ruleSet.forbidden.find((candidate) => candidate.name === ruleName);
  if (typeof rule?.comment === "string" && rule.comment.length > 0) return rule.comment;
  console.error(
    `The rule "${ruleName}" fired and has no \`comment\` in .dependency-cruiser.mjs. The ` +
      `comment is the whole message a developer gets, so a rule without one reports a ` +
      `violation nobody can act on. Give it one that explains the reason rather than ` +
      `restating the pattern.`
  );
  process.exit(1);
};

const reportViolations = (report) => {
  for (const violation of report.summary.violations) {
    const path = violation.cycle
      ? [violation.from, ...violation.cycle.map((step) => step.name)].join(" → ")
      : `${violation.from} → ${violation.to}`;
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
  console.log(
    `module graph clean: ${report.summary.totalCruised} modules, ` +
      `${report.summary.totalDependenciesCruised} dependencies.`
  );
};

/**
 * The diagram ARCHITECTURE.md publishes: one node per slice rather than per
 * file, which is the altitude that document argues at, and without the tests
 * or the API harness, which reach everywhere by design and would say
 * nothing about the shape.
 */
const renderGraph = async () => {
  const report = await cruiseSource({
    outputType: "mermaid",
    validate: false,
    collapse: "^src/(core|shell)/[^/]+",
    includeOnly: { path: "^src/" },
    exclude: { path: ["\\.test\\.ts$", "^src/shell/testing/"] },
    reporterOptions: { mermaid: { minify: false } },
  });
  return report.output.trim();
};

const GRAPH_START = "<!-- dependency-graph -->";
const GRAPH_END = "<!-- /dependency-graph -->";

const spliceGraph = (document, graph) => {
  const start = document.indexOf(GRAPH_START);
  const end = document.indexOf(GRAPH_END);
  if (start < 0 || end < 0) {
    console.error(`ARCHITECTURE.md is missing the ${GRAPH_START} / ${GRAPH_END} markers.`);
    process.exit(1);
  }
  const block = `${GRAPH_START}\n\n\`\`\`mermaid\n${graph}\n\`\`\`\n\n`;
  return document.slice(0, start) + block + document.slice(end);
};

const write = process.argv.includes("--write");

// Rules before the diagram, and not the other way round: any change to the
// graph makes the diagram stale, so checking that first would answer a genuine
// architecture violation with "your picture is out of date".
//
// The tripwire runs on both paths, the rules only on the checking one. Skipping
// the tripwire while writing is how a broken install would splice a diagram of
// nothing into ARCHITECTURE.md and report success — the very failure this
// file's header describes. Writing does not run the rules, so that regenerating
// the picture is never blocked by a violation somewhere else in the graph.
const report = await cruiseReport({ validate: !write });
assertCruisedSomething(report);
if (!write) reportViolations(report);

const document = readFileSync(architectureFile, "utf8");
const regenerated = spliceGraph(document, await renderGraph());

if (write) {
  writeFileSync(architectureFile, regenerated);
  console.log("ARCHITECTURE.md dependency graph regenerated.");
} else if (regenerated !== document) {
  console.error(
    "ARCHITECTURE.md's dependency graph no longer matches the code. It is generated, not " +
      "maintained: run `bun run graph` and commit the result."
  );
  process.exit(1);
}
