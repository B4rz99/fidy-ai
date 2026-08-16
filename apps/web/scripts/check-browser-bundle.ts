#!/usr/bin/env bun

import { decodeBuildMetafile } from "./build-metafile";

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const outdir = `/tmp/fidy-web-bundle-${process.pid}`;

const forbiddenDependencies = [
  /(^|\/)node_modules\/@effect\/ai-openai\//u,
  /(^|\/)node_modules\/@effect\/platform\//u,
  /(^|\/)node_modules\/@effect\/platform-bun\//u,
  /(^|\/)node_modules\/@effect\/sql-pg\//u,
  /(^|\/)node_modules\/@kapso\//u,
  /(^|\/)node_modules\/@sentry\//u,
  /(^|\/)node_modules\/pg\//u,
  /(^|\/)node_modules\/postgres\//u,
] as const;

const forbiddenNodeModules =
  /(^|\/)node_modules\/(?:effect\/dist\/unstable\/sql|(?:pg|postgres)(?:\/|$))/u;
const forbiddenNodeBuiltin =
  /^(?:node:|bun:)(?:assert|child_process|cluster|crypto|dgram|dns|fs|http|https|module|net|os|path|perf_hooks|process|stream|timers|tls|tty|util|v8|vm|worker_threads)(?:\/|$)/u;
const allowedServerSource = [
  /^apps\/server\/src\/client\.ts$/u,
  /^apps\/server\/src\/http-origin\.ts$/u,
  /^apps\/server\/src\/core\//u,
  /^apps\/server\/src\/shell\/api\.ts$/u,
  /^apps\/server\/src\/shell\/[^/]+\/operations\.ts$/u,
  /^apps\/server\/src\/shell\/ingestion\/input\.ts$/u,
  /^apps\/server\/src\/shell\/memory\/errors\.ts$/u,
  /^apps\/server\/src\/shell\/_shared\/(?:authz|canonical-telemetry|errors|http-status|operation-catalog|operation-policy|partial-input|response)\.ts$/u,
  /^apps\/server\/src\/shell\/_shared\/canonical-input\.ts$/u,
] as const;

const removeOutput = (): void => {
  Bun.spawnSync(["rm", "-rf", outdir]);
};

const repositoryPath = (input: string): string => {
  const normalized = input.replaceAll("\\", "/");
  const absolute = normalized.startsWith("/")
    ? normalized
    : Bun.fileURLToPath(new URL(normalized, `file://${webRoot}/`)).replaceAll("\\", "/");
  return absolute.startsWith(`${workspaceRoot}/`)
    ? absolute.slice(workspaceRoot.length + 1)
    : absolute;
};

const resolveSourcePath = async (basePath: string): Promise<string> => {
  for (const extension of ["", ".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = `${basePath}${extension}`;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Could not resolve browser source alias ${basePath}`);
};

const sourceImports = (
  sources: ReadonlyArray<{ sourceFile: string; source: string }>
): ReadonlyArray<{ importPath: string; sourceFile: string }> =>
  sources.flatMap(({ source, sourceFile }) =>
    Array.from(source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)).flatMap((match) =>
      match[1] === undefined ? [] : [{ importPath: match[1], sourceFile }]
    )
  );

removeOutput();
try {
  const result = await Bun.build({
    entrypoints: [`${webRoot}/src/main.tsx`],
    outdir,
    target: "browser",
    metafile: true,
    loader: { ".html": "text" },
    plugins: [
      {
        name: "vite-source-loaders",
        setup(build): void {
          build.onResolve({ filter: /^@\//u }, async ({ path }) => ({
            path: await resolveSourcePath(`${webRoot}/src/${path.slice(2)}`),
          }));
          build.onResolve({ filter: /^~\//u }, async ({ path }) => ({
            path: await resolveSourcePath(`${workspaceRoot}/apps/server/src/${path.slice(2)}`),
          }));
          build.onResolve({ filter: /^@fidy\/server\/client$/u }, () => ({
            path: `${workspaceRoot}/apps/server/src/client.ts`,
          }));
          build.onResolve({ filter: /\.html\?raw$/u }, ({ importer, path }) => ({
            path: Bun.fileURLToPath(
              new URL(path.replace(/\?raw$/u, ""), `file://${importer.replace(/[^/]+$/u, "")}`)
            ),
          }));
          build.onResolve({ filter: /\.css$/u }, () => ({ path: "web.css", external: true }));
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => JSON.stringify(log)).join("\n"));
  }

  const metafile = decodeBuildMetafile(result.metafile);
  const inputs = Object.keys(metafile.inputs).map(repositoryPath);
  const forbidden = inputs.filter(
    (input) =>
      forbiddenDependencies.some((dependency) => dependency.test(input)) ||
      forbiddenNodeModules.test(input) ||
      forbiddenNodeBuiltin.test(input)
  );
  const unexpectedServerInput = inputs.filter(
    (input) =>
      input.startsWith("apps/server/src/") &&
      !allowedServerSource.some((pattern) => pattern.test(input))
  );
  if (forbidden.length > 0 || unexpectedServerInput.length > 0) {
    const sections = [
      forbidden.length > 0
        ? `Browser-incompatible runtime modules entered the web bundle:\n${forbidden.join("\n")}`
        : undefined,
      unexpectedServerInput.length > 0
        ? `Unexpected server modules entered the web bundle:\n${unexpectedServerInput.join("\n")}`
        : undefined,
    ].filter((section): section is string => section !== undefined);
    throw new Error(sections.join("\n"));
  }

  const sourceFiles = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: webRoot }));
  const sources = await Promise.all(
    sourceFiles.map((sourceFile) =>
      Bun.file(`${webRoot}/${sourceFile}`)
        .text()
        .then((source) => ({ sourceFile, source }))
    )
  );
  const imports = sourceImports(sources);
  const forbiddenServerImport = imports.find(({ importPath, sourceFile }) => {
    if (importPath.startsWith("@fidy/server")) {
      return importPath !== "@fidy/server/client" || !sourceFile.startsWith("src/transport/");
    }
    if (importPath.startsWith("~/")) return true;
    if (!importPath.startsWith(".")) return false;
    const resolved = Bun.fileURLToPath(
      new URL(importPath, `file://${webRoot}/${sourceFile.replace(/[^/]+$/u, "")}`)
    );
    return resolved.startsWith(`${workspaceRoot}/apps/server/src/`);
  });
  const directFetch = sources.find(({ source }) => /\bfetch\s*\(/u.test(source));
  const alternateStateClient = imports.find(({ importPath }) =>
    /^(?:@apollo\/client|@tanstack\/(?:query|react-query)|redux|swr|zustand)(?:\/|$)/u.test(
      importPath
    )
  );
  if (forbiddenServerImport !== undefined) {
    throw new Error(
      `${forbiddenServerImport.sourceFile} imports a server client outside transport: ${forbiddenServerImport.importPath}`
    );
  }
  if (directFetch !== undefined) {
    throw new Error(`${directFetch.sourceFile} calls fetch directly; use the transport seam`);
  }
  if (alternateStateClient !== undefined) {
    throw new Error(
      `${alternateStateClient.sourceFile} imports alternate server state ${alternateStateClient.importPath}`
    );
  }

  process.stdout.write(
    `web browser graph clean: ${inputs.length} bundled modules (${workspaceRoot})\n`
  );
} finally {
  removeOutput();
}
