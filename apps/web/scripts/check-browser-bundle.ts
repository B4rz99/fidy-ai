#!/usr/bin/env bun

import { Option } from "effect";
import { decodeBuildMetafile } from "./build-metafile";

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
  /(^|\/)node_modules\/(?:effect\/dist\/unstable\/sql|(?:pg|postgres|postgres-array|postgres-bytea)(?:\/|$))/u;
const forbiddenNodeBuiltin =
  /^(?:node:|bun:)[^/]+(?:\/|$)|^(?:assert|child_process|cluster|crypto|dgram|dns|fs|http|https|module|net|os|path|perf_hooks|process|stream|timers|tls|tty|util|v8|vm|worker_threads)(?:\/|$)/u;

/** Configures the web source root used by the browser bundle gate, primarily for isolated tests. */
export type BrowserBundleCheckOptions = Readonly<{
  readonly entrypoint: string;
  readonly outdir: string;
  readonly webRoot: string;
  readonly workspaceRoot: string;
}>;

type Source = Readonly<{ sourceFile: string; source: string }>;
type SourceImport = Readonly<{ importPath: string; sourceFile: string }>;
type BrowserBuildPlugin = NonNullable<Parameters<typeof Bun.build>[0]["plugins"]>[number];

const defaultOptions = (): BrowserBundleCheckOptions => ({
  entrypoint: "src/main.tsx",
  outdir: `/tmp/fidy-web-bundle-${process.pid}`,
  webRoot: Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, ""),
  workspaceRoot: Bun.fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, ""),
});

const removeOutput = (outdir: string): void => {
  const result = Bun.spawnSync(["rm", "-rf", outdir], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
};

const repositoryPath = (input: string, webRoot: string, workspaceRoot: string): string => {
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

const browserBuildPlugins = (webRoot: string, workspaceRoot: string): Array<BrowserBuildPlugin> => [
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
];

const buildBrowserBundle = async (options: BrowserBundleCheckOptions): Promise<unknown> => {
  const result = await Bun.build({
    entrypoints: [`${options.webRoot}/${options.entrypoint}`],
    outdir: options.outdir,
    target: "browser",
    metafile: true,
    splitting: true,
    loader: { ".html": "text" },
    plugins: browserBuildPlugins(options.webRoot, options.workspaceRoot),
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => JSON.stringify(log)).join("\n"));
  }
  return result.metafile;
};

const sourceImports = (sources: ReadonlyArray<Source>): ReadonlyArray<SourceImport> =>
  sources.flatMap(({ source, sourceFile }) =>
    Array.from(source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)).flatMap((match) =>
      match[1] === undefined ? [] : [{ importPath: match[1], sourceFile }]
    )
  );

const readWebSources = async (webRoot: string): Promise<ReadonlyArray<Source>> => {
  const sourceFiles = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: webRoot }));
  return Promise.all(
    sourceFiles.map((sourceFile) =>
      Bun.file(`${webRoot}/${sourceFile}`)
        .text()
        .then((source) => ({ sourceFile, source }))
    )
  );
};

type BuildOutputs = NonNullable<ReturnType<typeof decodeBuildMetafile>["outputs"]>;

const outputImportPath = (
  importer: string,
  importPath: string,
  outputs: BuildOutputs
): Option.Option<string> => {
  if (outputs[importPath] !== undefined) return Option.some(importPath);
  const directory = importer.slice(0, importer.lastIndexOf("/") + 1);
  const relative = importPath.startsWith("./") ? importPath.slice(2) : importPath;
  const candidate = `${directory}${relative}`;
  return Option.fromUndefinedOr(outputs[candidate]).pipe(Option.as(candidate));
};

const staticOutputImports = (outputPath: string, outputs: BuildOutputs): ReadonlyArray<string> =>
  (outputs[outputPath]?.imports ?? [])
    .filter(({ kind }) => kind !== "dynamic-import")
    .flatMap(({ path }) => Option.toArray(outputImportPath(outputPath, path, outputs)));

const collectStaticOutputs = (entry: string, outputs: BuildOutputs): ReadonlySet<string> => {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (outputPath === undefined || visited.has(outputPath)) continue;
    visited.add(outputPath);
    pending.push(...staticOutputImports(outputPath, outputs));
  }
  return visited;
};

const findBrowserEntry = (outputs: BuildOutputs): Option.Option<string> =>
  Option.fromUndefinedOr(
    Object.entries(outputs).find(([, output]) =>
      (output.entryPoint ?? "").replaceAll("\\", "/").endsWith("src/main.tsx")
    )
  ).pipe(Option.map(([outputPath]) => outputPath));

const assertNoDashboardInInitialInputs = (inputs: ReadonlyArray<string>): void => {
  const leaked = inputs.filter(
    (input) => input.includes("/features/dashboard/") || input.includes("node_modules/recharts/")
  );
  if (leaked.length > 0) {
    throw new Error(
      `Dashboard modules entered the public/auth initial chunk:\n${leaked.join("\n")}`
    );
  }
};

const assertDashboardSplitEvidence = (inputs: ReadonlyArray<string>): void => {
  if (!inputs.some((input) => input.includes("/features/dashboard/"))) {
    throw new Error("Dashboard split-chunk evidence is missing from the browser build");
  }
  if (!inputs.some((input) => input.includes("node_modules/recharts/"))) {
    throw new Error("Recharts split-chunk evidence is missing from the browser build");
  }
};

const assertDashboardChunkIsolation = (
  metafile: ReturnType<typeof decodeBuildMetafile>,
  webRoot: string,
  workspaceRoot: string
): void => {
  const outputs = Option.fromUndefinedOr(metafile.outputs).pipe(
    Option.getOrThrowWith(() => new Error("Browser build did not report split outputs"))
  );
  const entry = findBrowserEntry(outputs).pipe(
    Option.getOrThrowWith(() => new Error("Browser build did not report the web entry chunk"))
  );
  const initialInputs = [...collectStaticOutputs(entry, outputs)].flatMap((outputPath) =>
    Object.keys(outputs[outputPath]?.inputs ?? {}).map((input) =>
      repositoryPath(input, webRoot, workspaceRoot)
    )
  );
  assertNoDashboardInInitialInputs(initialInputs);
  assertDashboardSplitEvidence(
    Object.keys(metafile.inputs).map((input) => repositoryPath(input, webRoot, workspaceRoot))
  );
};

const validateForbiddenInputs = (
  metafile: ReturnType<typeof decodeBuildMetafile>,
  webRoot: string,
  workspaceRoot: string
): number => {
  const inputs = Object.keys(metafile.inputs).map((input) =>
    repositoryPath(input, webRoot, workspaceRoot)
  );
  const forbidden = inputs.filter(
    (input) =>
      forbiddenDependencies.some((dependency) => dependency.test(input)) ||
      forbiddenNodeModules.test(input) ||
      forbiddenNodeBuiltin.test(input)
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Browser-incompatible runtime modules entered the web bundle:\n${forbidden.join("\n")}`
    );
  }
  return inputs.length;
};

const findForbiddenServerImport = (
  imports: ReadonlyArray<SourceImport>,
  webRoot: string,
  workspaceRoot: string
): Option.Option<SourceImport> =>
  Option.fromUndefinedOr(
    imports.find(({ importPath, sourceFile }) => {
      if (importPath.startsWith("@fidy/server")) {
        return importPath !== "@fidy/server/client" || !sourceFile.startsWith("src/transport/");
      }
      if (importPath.startsWith("~/")) return true;
      if (!importPath.startsWith(".")) return false;
      const resolved = Bun.fileURLToPath(
        new URL(importPath, `file://${webRoot}/${sourceFile.replace(/[^/]+$/u, "")}`)
      );
      return resolved.startsWith(`${workspaceRoot}/apps/server/src/`);
    })
  );

const assertSourceBoundary = (
  sources: ReadonlyArray<Source>,
  webRoot: string,
  workspaceRoot: string
): void => {
  const imports = sourceImports(sources);
  const forbiddenServerImport = findForbiddenServerImport(imports, webRoot, workspaceRoot);
  const directFetch = sources.find(({ source }) => /\bfetch\s*\(/u.test(source));
  const alternateStateClient = imports.find(({ importPath }) =>
    /^(?:@apollo\/client|@tanstack\/(?:query|react-query)|redux|swr|zustand)(?:\/|$)/u.test(
      importPath
    )
  );
  const alternateHttpClient = imports.find(({ importPath }) =>
    /^(?:axios|graphql-request|ky|superagent)(?:\/|$)/u.test(importPath)
  );
  if (Option.isSome(forbiddenServerImport)) {
    throw new Error(
      `${forbiddenServerImport.value.sourceFile} imports a server client outside transport: ${forbiddenServerImport.value.importPath}`
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
};

/**
 * Builds the browser entrypoint and rejects forbidden runtime inputs plus web-source boundary
 * violations. The metafile check protects all reachable web dependencies; source checks protect
 * ownership rules that the module graph cannot express.
 */
export const checkBrowserBundle = async (options: BrowserBundleCheckOptions): Promise<void> => {
  removeOutput(options.outdir);
  try {
    const metafile = decodeBuildMetafile(await buildBrowserBundle(options));
    const inputs = validateForbiddenInputs(metafile, options.webRoot, options.workspaceRoot);
    assertDashboardChunkIsolation(metafile, options.webRoot, options.workspaceRoot);
    assertSourceBoundary(
      await readWebSources(options.webRoot),
      options.webRoot,
      options.workspaceRoot
    );
    process.stdout.write(`web browser graph clean: ${inputs} bundled modules\n`);
  } finally {
    removeOutput(options.outdir);
  }
};

if (import.meta.main) {
  await checkBrowserBundle(defaultOptions());
}
