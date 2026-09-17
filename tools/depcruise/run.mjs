// Runs the module-graph gate defined in the current package's `.dependency-cruiser.mjs`.
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";

const packageRoot = resolve(process.argv[2] ?? process.cwd());
const graphRoots = process.argv.slice(3);
const sourceRoots = graphRoots.length > 0 ? graphRoots : ["src"];

// The cruiser resolves every path against the cwd, and the reported module
// names are what the rule patterns match, so both must be package-root-relative.
process.chdir(packageRoot);

const ruleSet = await extractDepcruiseConfig(resolve(packageRoot, ".dependency-cruiser.mjs"));
const tsConfig = extractTSConfig(resolve(packageRoot, ruleSet.options.tsConfig.fileName));

const cruiseSource = (options) => cruise(sourceRoots, { ruleSet, ...options }, null, { tsConfig });

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

const displayPath = (path) => path.replace(/^(?:\.\.\/)+node_modules\//u, "node_modules/");

// Dependency-cruiser marks direct `export ... from` edges, but a local `export { imported }`
// loses that provenance. Inspect only Published Trio interfaces to close that laundering form.
const isInternalSpecifier = (specifier) =>
  [
    specifier.startsWith("./internal/"),
    specifier.startsWith("../internal/"),
    specifier.includes("/internal/"),
  ].includes(true);

const importNames = (clause) => {
  const names = clause.name === undefined ? [] : [clause.name.text];
  const named = clause.namedBindings;
  if (named === undefined) return names;
  if (ts.isNamespaceImport(named)) return [...names, named.name.text];
  return [...names, ...named.elements.map((element) => element.name.text)];
};

const internalImport = (statement) => {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }
  const specifier = statement.moduleSpecifier.text;
  if (!isInternalSpecifier(specifier) || statement.importClause === undefined) return [];
  return importNames(statement.importClause).map((name) => [name, specifier]);
};

const importedBindings = (sourceFile) => new Map(sourceFile.statements.flatMap(internalImport));

const localExportNames = (statement) => {
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier === undefined &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements.map(
      (element) => (element.propertyName ?? element.name).text
    );
  }
  if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
    return [statement.expression.text];
  }
  return [];
};

const exportedVariableAliases = (statement) => {
  if (
    !ts.isVariableStatement(statement) ||
    !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) =>
    declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)
      ? [declaration.initializer.text]
      : []
  );
};

const locallyExportedBindings = (sourceFile) =>
  sourceFile.statements.flatMap((statement) => [
    ...localExportNames(statement),
    ...exportedVariableAliases(statement),
  ]);

const reportLaunderedInternals = (report) => {
  let violations = 0;
  for (const module of report.modules) {
    if (!/^src\/(core|shell)\/[^/]+\/(contract|operations|runtime)\.ts$/u.test(module.source)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      module.source,
      readFileSync(module.source, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const imports = importedBindings(sourceFile);
    for (const binding of locallyExportedBindings(sourceFile)) {
      const specifier = imports.get(binding);
      if (specifier === undefined) continue;
      violations += 1;
      console.error(
        `error published-interface-reexports-internal: ${module.source} → ${specifier}`
      );
      console.error(`  ${ruleReason("published-interface-reexports-internal")}\n`);
    }
  }
  return violations;
};

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
  console.log(
    `module graph clean: ${report.summary.totalCruised} modules, ` +
      `${report.summary.totalDependenciesCruised} dependencies.`
  );
};

const report = await cruiseReport({ validate: true });
assertCruisedSomething(report);
const launderedInternals = reportLaunderedInternals(report);
reportViolations(report);
if (launderedInternals > 0) {
  process.exit(1);
}
