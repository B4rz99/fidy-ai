// Export provenance is independent of import-boundary validation.
import { loadGraph } from "./graph.mjs";
import { launderingViolations } from "./laundering.mjs";

const { packageRoot, report } = await loadGraph(
  process.argv[2] ?? process.cwd(),
  process.argv.slice(3),
  false
);
const violations = launderingViolations(report, packageRoot);
for (const { name, from, to, reason } of violations) {
  console.error(`error ${name}: ${from} → ${to}`);
  console.error(`  ${reason}\n`);
}
if (violations.length > 0) process.exit(1);
console.log("published interfaces clean");
