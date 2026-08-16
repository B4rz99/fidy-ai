#!/usr/bin/env bun

/**
 * This gate checks browser-owned source imports. The server-owned browser-client gate is the sole
 * transitive allowlist for what the canonical @fidy/server/client facade may bring into a browser.
 */
const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const outdir = `/tmp/fidy-web-bundle-${process.pid}`;

const removeOutput = (): void => {
  Bun.spawnSync(["rm", "-rf", outdir]);
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
  const alternateHttpClient = imports.find(({ importPath }) =>
    /^(?:axios|graphql-request|ky|superagent)(?:\/|$)/u.test(importPath)
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
  if (alternateHttpClient !== undefined) {
    throw new Error(
      `${alternateHttpClient.sourceFile} imports alternate HTTP client ${alternateHttpClient.importPath}`
    );
  }

  process.stdout.write("web browser source boundary clean\n");
} finally {
  removeOutput();
}
