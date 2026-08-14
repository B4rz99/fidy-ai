#!/usr/bin/env bun

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const outdir = `/tmp/fidy-web-bundle-${process.pid}`;

const forbiddenDependencies = [
  "/node_modules/@effect/ai-openai/",
  "/node_modules/@effect/platform-bun/",
  "/node_modules/@effect/sql-pg/",
  "/node_modules/@kapso/",
  "/node_modules/@sentry/",
  "/node_modules/pg/",
  "/node_modules/postgres/",
] as const;

type Metafile = Readonly<{ inputs: Readonly<Record<string, unknown>> }>;

const isMetafile = (value: unknown): value is Metafile =>
  typeof value === "object" &&
  value !== null &&
  "inputs" in value &&
  typeof value.inputs === "object" &&
  value.inputs !== null;

const removeOutput = (): void => {
  Bun.spawnSync(["rm", "-rf", outdir]);
};

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

  const rawMetafile: unknown = result.metafile;
  const parsedMetafile: unknown =
    typeof rawMetafile === "string" ? JSON.parse(rawMetafile) : rawMetafile;
  if (!isMetafile(parsedMetafile)) {
    throw new Error("Browser build did not return a module graph");
  }

  const inputs = Object.keys(parsedMetafile.inputs).map((path) => path.replaceAll("\\", "/"));
  const forbidden = inputs.filter((input) =>
    forbiddenDependencies.some((dependency) => input.includes(dependency))
  );
  if (forbidden.length > 0) {
    throw new Error(`Backend dependencies entered the web bundle:\n${forbidden.join("\n")}`);
  }

  const sourceFiles = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: webRoot }));
  const sources = await Promise.all(
    sourceFiles.map(async (sourceFile) => ({
      sourceFile,
      source: await Bun.file(`${webRoot}/${sourceFile}`).text(),
    }))
  );
  const serverSourceRoot = `${workspaceRoot}/apps/server/src/`;
  const forbiddenServerImport = sources
    .flatMap(({ source, sourceFile }) =>
      Array.from(source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)).map((match) => ({
        importPath: match[1],
        sourceFile,
      }))
    )
    .find(({ importPath, sourceFile }) => {
      if (importPath.startsWith("@fidy/server")) return importPath !== "@fidy/server/client";
      if (importPath.startsWith("~/")) return true;
      if (!importPath.startsWith(".")) return false;
      const resolved = Bun.fileURLToPath(
        new URL(importPath, `file://${webRoot}/${sourceFile.replace(/[^/]+$/u, "")}`)
      );
      return resolved.startsWith(serverSourceRoot);
    });
  if (forbiddenServerImport !== undefined) {
    throw new Error(
      `${forbiddenServerImport.sourceFile} imports forbidden server path ${forbiddenServerImport.importPath}`
    );
  }

  process.stdout.write(
    `web browser graph clean: ${inputs.length} bundled modules (${workspaceRoot})\n`
  );
} finally {
  removeOutput();
}
