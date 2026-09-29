#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { Schema } from "effect";

const args = Bun.argv.slice(2);
const rootIndex = args.indexOf("--root");
if (rootIndex !== -1 && (rootIndex !== 0 || args.length !== 2)) {
  process.stderr.write("Usage: check-legacy-authorities.ts [--root path]\n");
  process.exit(2);
}
const root = rootIndex === -1 ? Bun.fileURLToPath(new URL("..", import.meta.url)) : args[1];
if (root === undefined) process.exit(2);

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const findings: Array<string> = [];
const sourceSuffix = /\.[cm]?[jt]sx?$/u;
const legacyName =
  /(?:^|[./-])(?:railway|postgres(?:ql)?|hyperdrive|dockerfile|pg-repos?|persisted-queue)(?:[./-]|$)/iu;
const legacyAuthority =
  /@effect\/(?:sql-pg|platform-bun|cluster)|effect\/unstable\/cluster|\b(?:postgres(?:ql)?|hyperdrive|railway|persisted[_-]?queue|sentry)\b/iu;
const legacyTestImport =
  /(?:from\s*|import\s*\(|require\s*\()\s*["'](@effect\/(?:sql-pg|platform-bun|cluster)|effect\/unstable\/cluster|pg)(?:\/[^"']*)?["']/u;
const postgresService = /\b(postgres)(?=:\d+\b)/iu;
const pgImport = /(?:from\s*|import\s*\(|require\s*\()\s*["'](pg)(?:\/[^"']*)?["']/u;
const legacySql =
  /\bCREATE\s+(?:ROLE|FUNCTION|POLICY|EXTENSION)\b|\bROW LEVEL SECURITY\b|\b(?:postgres(?:ql)?|hyperdrive|railway|persisted[_-]?queue|sentry)\b/iu;
const configSuffix = /(?:\.(?:jsonc?|ya?ml|toml|env|sh)|^\.env(?:\.|$))/u;
const productionRoots = [
  "apps/server/src",
  "apps/server/cloudflare",
  "apps/web/src",
  "infra/cloudflare",
];
const ignoredDirectories = new Set([
  ".git",
  ".repos",
  ".agents",
  ".claude",
  ".patterns",
  "docs",
  "research",
  ".npm",
  ".tsbuild",
  ".cache",
  ".next",
  ".output",
  ".turbo",
  "node_modules",
  "dist",
  "coverage",
  ".alchemy",
  ".wrangler",
]);
const scriptRoots = [
  "scripts",
  "apps/server/scripts",
  "apps/web/scripts",
  "infra/cloudflare/scripts",
];
// These Bun-backed tests exercise local infrastructure, not the production Worker runtime.
const developmentTooling = new Set([
  "infra/cloudflare/scripts/migration-history.test.ts",
  "infra/cloudflare/local-emulation.test.ts",
  "infra/cloudflare/smoke-admission.test.ts",
]);
const runtimeScripts = new Set<string>();

const recordRuntimeScript = (path: string, name: string, command: string): void => {
  if (/^(?:start|serve)$/u.test(name) && path.startsWith("apps/server/")) {
    findings.push(`${path}: ${name} production process entrypoint`);
  }
  const match =
    /(?:^|\s)(?:bun|node)\s+(?:--bun\s+)?(?:\.\/)?(scripts\/[^\s;&|]+\.[cm]?[jt]s)/u.exec(command);
  if (match?.[1] !== undefined) {
    runtimeScripts.add(`${path.slice(0, -"package.json".length)}${match[1]}`);
  }
};

const recordManifestScripts = (path: string, scripts: Record<string, string>): void => {
  for (const [name, command] of Object.entries(scripts)) {
    if (legacyAuthority.test(command)) findings.push(`${path}: ${name}`);
  }
  const visited = new Set<string>();
  const visitProductionScript = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const command = scripts[name];
    if (command === undefined) return;
    recordRuntimeScript(path, name, command);
    for (const match of command.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:-]+)/gu)) {
      if (match[1] !== undefined) visitProductionScript(match[1]);
    }
  };
  for (const name of Object.keys(scripts)) {
    if (/^(?:start|serve|production(?::|$))/u.test(name)) {
      visitProductionScript(name);
    }
  }
};

const checkManifest = (path: string): void => {
  const manifest = Schema.decodeUnknownSync(Manifest)(
    JSON.parse(readFileSync(`${root}/${path}`, "utf8"))
  );
  for (const name of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]) {
    if (name === "pg" || legacyAuthority.test(name)) findings.push(`${path}: ${name}`);
  }
  recordManifestScripts(path, manifest.scripts ?? {});
};

const isTestSource = (path: string): boolean =>
  /(?:\.test|\.spec|\.fixture)\.[cm]?[jt]sx?$/u.test(path);

const isProductionSource = (path: string): boolean =>
  (productionRoots.some((prefix) => path.startsWith(`${prefix}/`)) ||
    scriptRoots.some((prefix) => path.startsWith(`${prefix}/`))) &&
  path !== "scripts/check-legacy-authorities.ts" &&
  !developmentTooling.has(path) &&
  !isTestSource(path) &&
  sourceSuffix.test(path);

const isWorkflow = (path: string): boolean =>
  path.startsWith(".github/workflows/") && /\.ya?ml$/u.test(path);

const checkLegacyTest = (path: string): void => {
  const text = readFileSync(`${root}/${path}`, "utf8");
  for (const line of text.split("\n")) {
    const match =
      legacyTestImport.exec(line) ??
      postgresService.exec(line) ??
      /\b(postgres)(?:ql)?:\/\//iu.exec(line) ??
      /\b(?:execFileSync|spawnSync|spawn|execFile)\s*\(\s*["'](psql)["']/u.exec(line);
    if (match === null || (match[1] === "@effect/platform-bun" && developmentTooling.has(path))) {
      continue;
    }
    findings.push(`${path}: ${match[1]}`);
  }
};

const isAllowedBunTool = (path: string, authority: string): boolean =>
  authority === "@effect/platform-bun" &&
  scriptRoots.some((prefix) => path.startsWith(`${prefix}/`)) &&
  !runtimeScripts.has(path);

const checkSource = (path: string): void => {
  if (!isProductionSource(path) && !isWorkflow(path)) return;
  const text = readFileSync(`${root}/${path}`, "utf8");
  for (const line of text.split("\n")) {
    const match = legacyAuthority.exec(line) ?? pgImport.exec(line);
    if (match === null) continue;
    if (isAllowedBunTool(path, match[0])) continue;
    findings.push(`${path}: ${match[1] ?? match[0]}`);
  }
};

const checkConfig = (path: string): void => {
  const match = legacyAuthority.exec(readFileSync(`${root}/${path}`, "utf8"));
  if (match !== null) findings.push(`${path}: ${match[0]}`);
};

const checkSql = (path: string): void => {
  const match = legacySql.exec(readFileSync(`${root}/${path}`, "utf8"));
  if (match !== null) findings.push(`${path}: ${match[0]}`);
};

const checkContent = (path: string): void => {
  if (configSuffix.test(path)) checkConfig(path);
  if (path.endsWith(".sql")) checkSql(path);
  if (
    isTestSource(path) &&
    ["apps/server/", "apps/web/", "infra/cloudflare/"].some((prefix) => path.startsWith(prefix))
  ) {
    checkLegacyTest(path);
    return;
  }
  checkSource(path);
};

const checkFile = (path: string): void => {
  if (legacyName.test(path) || path === ".dockerignore") {
    findings.push(`${path}: legacy production path`);
  }
  if (path.endsWith("/package.json") || path === "package.json") {
    checkManifest(path);
    return;
  }
  checkContent(path);
};

const files: Array<string> = [];
const scan = (directory: string): void => {
  const entries = readdirSync(`${root}/${directory}`, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) scan(path);
    else if (entry.isFile()) files.push(path);
  }
};

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (ignoredDirectories.has(entry.name)) continue;
  if (entry.isFile()) files.push(entry.name);
  else if (entry.isDirectory()) scan(entry.name);
}
for (const path of files.filter((file) => file.endsWith("package.json"))) checkFile(path);
for (const path of files.filter((file) => !file.endsWith("package.json"))) checkFile(path);

if (findings.length > 0) {
  process.stderr.write(
    `Legacy production authorities found:\n${findings.map((item) => `- ${item}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("No legacy production authorities found.\n");
}
