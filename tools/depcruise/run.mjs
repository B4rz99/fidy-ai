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

// Dependency-cruiser marks direct `export ... from` edges, but a local `export { imported }`
// loses that provenance. Inspect only Published Trio interfaces to close that laundering form.
/** @param {string} specifier - Relative import path to inspect. */
const isInternalSpecifier = (specifier) =>
  [
    specifier.startsWith("./internal/"),
    specifier.startsWith("../internal/"),
    specifier.includes("/internal/"),
  ].includes(true);

/** @param {import("typescript").ImportClause} clause - Imported bindings. */
const importNames = (clause) => {
  const names = clause.name === undefined ? [] : [clause.name.text];
  const named = clause.namedBindings;
  if (named === undefined) return names;
  if (ts.isNamespaceImport(named)) return [...names, named.name.text];
  return [...names, ...named.elements.map((element) => element.name.text)];
};

/**
 * @param {import("typescript").Statement} statement - Candidate import.
 * @returns {Array<readonly [string, string]>} Local binding and internal specifier pairs.
 */
const internalImport = (statement) => {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }
  const specifier = statement.moduleSpecifier.text;
  if (!isInternalSpecifier(specifier) || statement.importClause === undefined) return [];
  return importNames(statement.importClause).map((name) => [name, specifier]);
};

/**
 * @param {import("typescript").Statement} statement - Candidate alias declaration.
 * @returns {Array<readonly [string, string]>} Local alias and source binding pairs.
 */
const localAliases = (statement) => {
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    ts.isIdentifier(declaration.initializer)
      ? [[declaration.name.text, declaration.initializer.text]]
      : []
  );
};

/** @param {import("typescript").SourceFile} sourceFile - Published interface module. */
const internalBindings = (sourceFile) => {
  const bindings = new Map(sourceFile.statements.flatMap(internalImport));
  const aliases = sourceFile.statements.flatMap(localAliases);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, source] of aliases) {
      const specifier = bindings.get(source);
      if (specifier === undefined || bindings.has(alias)) continue;
      bindings.set(alias, specifier);
      changed = true;
    }
  }
  return bindings;
};

/** @param {import("typescript").Statement} statement - Candidate local export. */
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

/** @param {import("typescript").Statement} statement - Candidate exported declaration. */
const isExported = (statement) =>
  ts.canHaveModifiers(statement) &&
  ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
    true;

/** @param {import("typescript").Statement} statement - Candidate exported alias. */
const exportedVariableAliases = (statement) => {
  if (!ts.isVariableStatement(statement) || !isExported(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)
      ? [declaration.initializer.text]
      : []
  );
};

/** @param {import("typescript").Statement} statement - Candidate exported type. */
const exportedTypeReferences = (statement) => {
  if (!(ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))) return [];
  if (!isExported(statement)) return [];
  /** @type {string[]} */
  const names = [];
  /** @param {import("typescript").Node} node - Identifier-bearing type syntax. */
  const visit = (node) => {
    if (ts.isIdentifier(node)) names.push(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(statement, visit);
  return names;
};

/** @param {import("typescript").SourceFile} sourceFile - Published interface module. */
const locallyExportedBindings = (sourceFile) =>
  new Set(
    sourceFile.statements.flatMap((statement) => [
      ...localExportNames(statement),
      ...exportedVariableAliases(statement),
      ...exportedTypeReferences(statement),
    ])
  );

/** @param {import("dependency-cruiser").ICruiseResult} report - Cruised module graph. */
const reportLaunderedInternals = (report) => {
  let violations = 0;
  for (const module of report.modules) {
    if (!/^src\/(core|shell)\/.+\/(contract|operations|runtime)\.ts$/u.test(module.source)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      module.source,
      readFileSync(module.source, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const imports = internalBindings(sourceFile);
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
  console.log(
    `module graph clean: ${report.summary.totalCruised} modules, ` +
      `${report.summary.totalDependenciesCruised} dependencies.`
  );
};

const report = await cruiseReport({ validate: true });
assertCruisedSomething(report);
const launderedInternals = reportLaunderedInternals(report);
const nestedForeignInternals = reportNestedForeignInternals(report);
reportViolations(report);
if (launderedInternals + nestedForeignInternals > 0) {
  process.exit(1);
}
