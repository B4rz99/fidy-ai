import { loadGraph } from "./graph.mjs";
import { boundaryViolations } from "./boundaries.mjs";

const { forbiddenRules, packageRoot, report } = await loadGraph(
  process.argv[2] ?? process.cwd(),
  process.argv.slice(3)
);

/** @param {string} name - Rule identifier; every rule must explain its boundary. */
const ruleReason = (name) => {
  const reason = forbiddenRules.find((rule) => rule.name === name)?.comment;
  if (!reason) throw new Error(`Dependency rule ${name} has no explanatory comment`);
  return reason;
};

/** @param {string} path - Package-relative module path. */
const displayPath = (path) => path.replace(/^(?:\.\.\/)+node_modules\//u, "node_modules/");

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

const boundaries = packageRoot.endsWith("/apps/server")
  ? boundaryViolations(report, packageRoot)
  : [];
for (const { name, from, to, reason } of boundaries) {
  console.error(`error ${name}: ${displayPath(from)} → ${displayPath(to)}`);
  console.error(`  ${reason}\n`);
}
reportViolations(report);
if (boundaries.length > 0) process.exit(1);
console.log(
  `module graph clean: ${report.summary.totalCruised} modules, ${report.summary.totalDependenciesCruised} dependencies.`
);
