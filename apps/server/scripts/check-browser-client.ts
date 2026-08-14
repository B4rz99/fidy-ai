#!/usr/bin/env bun

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/u, "");
const entrypoint = "src/client.ts";

/**
 * The browser seam is intentionally an allowlist of source and dependency modules. Slice operation
 * definitions may grow without editing this check; every other input must be admitted deliberately
 * so a server implementation cannot enter the client graph under a new filename or package.
 */
const safeSource = [
  /^src\/client\.ts$/u,
  /^src\/core\//u,
  /^src\/shell\/api\.ts$/u,
  /^src\/shell\/[^/]+\/operations\.ts$/u,
  /^src\/shell\/ingestion\/input\.ts$/u,
  /^src\/shell\/memory\/errors\.ts$/u,
  /^src\/shell\/_shared\/(?:authz|canonical-telemetry|errors|http-status|operation-catalog|operation-policy|partial-input|response)\.ts$/u,
  /^src\/shell\/_shared\/canonical-input\.ts$/u,
] as const;

const safeDependency = [
  /^node_modules\/effect\//u,
  /^node_modules\/fast-check\//u,
  /^node_modules\/pure-rand\//u,
] as const;

const forbiddenDependency = [
  /^node_modules\/effect\/dist\/unstable\/sql(?:\/|$)/u,
  /^node_modules\/@effect\/ai-openai(?:\/|$)/u,
  /^node_modules\/@effect\/platform(?:\/|$)/u,
  /^node_modules\/@effect\/platform-bun(?:\/|$)/u,
  /^node_modules\/@effect\/sql-pg(?:\/|$)/u,
  /^node_modules\/@kapso\//u,
  /^node_modules\/@sentry\//u,
  /^node_modules\/(?:pg|postgres|postgres-array|postgres-bytea)(?:\/|$)/u,
  /^(?:node:)?(?:child_process|cluster|dns|fs|http|https|net|os|stream|tls|worker_threads)(?:\/|$)/u,
] as const;

type Metafile = {
  readonly inputs: Readonly<Record<string, unknown>>;
};

const repositoryPath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const absolute = Bun.fileURLToPath(new URL(normalized, `file://${serverRoot}/`)).replaceAll(
    "\\",
    "/"
  );
  const root = absolute.startsWith(`${serverRoot}/`) ? serverRoot : workspaceRoot;
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : normalized;
};

const isMetafile = (value: unknown): value is Metafile =>
  typeof value === "object" &&
  value !== null &&
  "inputs" in value &&
  typeof value.inputs === "object" &&
  value.inputs !== null;

const outdir = `/tmp/fidy-browser-client-${process.pid}`;
const removeOutput = (): void => {
  const result = Bun.spawnSync(["rm", "-rf", outdir], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
};

removeOutput();
const mkdir = Bun.spawnSync(["mkdir", "-p", outdir], { stderr: "pipe" });
if (mkdir.exitCode !== 0) {
  throw new Error(new TextDecoder().decode(mkdir.stderr));
}

try {
  const result = await Bun.build({
    entrypoints: [`${serverRoot}/${entrypoint}`],
    metafile: true,
    outdir,
    target: "browser",
  });

  if (!result.success) {
    const logs = result.logs.map((log) => JSON.stringify(log)).join("\n");
    throw new Error(`Browser client build failed.\n${logs}`);
  }

  const rawMetafile: unknown = result.metafile;
  const parsedMetafile: unknown =
    typeof rawMetafile === "string" ? JSON.parse(rawMetafile) : rawMetafile;
  if (!isMetafile(parsedMetafile)) {
    throw new Error("Browser client build did not return a metafile");
  }

  const inputs = Object.keys(parsedMetafile.inputs).map(repositoryPath);
  const unexpectedInput = inputs.filter(
    (input) =>
      !safeSource.some((pattern) => pattern.test(input)) &&
      !safeDependency.some((pattern) => pattern.test(input))
  );
  const forbidden = inputs.filter((input) =>
    forbiddenDependency.some((pattern) => pattern.test(input))
  );

  if (unexpectedInput.length > 0 || forbidden.length > 0) {
    const sections = [
      unexpectedInput.length > 0
        ? `Unexpected modules in ${entrypoint}:\n${unexpectedInput.map((path) => `  - ${path}`).join("\n")}`
        : undefined,
      forbidden.length > 0
        ? `Forbidden dependencies in ${entrypoint}:\n${forbidden.map((path) => `  - ${path}`).join("\n")}`
        : undefined,
    ].filter((section): section is string => section !== undefined);
    throw new Error(
      `${sections.join("\n")}\nThe browser client seam may derive from canonical declarations, not server implementations.`
    );
  }

  process.stdout.write(`browser client graph clean: ${inputs.length} bundled modules\n`);
} finally {
  removeOutput();
}
