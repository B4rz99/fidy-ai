import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import serverConfig from "../../apps/server/.dependency-cruiser.mjs";
import webConfig from "../../apps/web/.dependency-cruiser.mjs";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
/** @param {string} application - Fixture application. @param {Record<string, string>} files - Fixture sources. @param {{entrypoint?: string, exclude?: string, publication?: boolean}} [options] - CLI and coverage fault. */
const inspect = (
  application,
  files,
  { entrypoint = "run.mjs", exclude, publication = false } = {}
) => {
  const temporary = mkdtempSync(join(tmpdir(), "fidy-architecture-"));
  const root = join(temporary, "apps", application);
  const config = application === "server" ? serverConfig : webConfig;
  const fixtureFiles = {
    "schema.d.ts": "declare const placeholder: string;",
    ...files,
    ".dependency-cruiser.mjs": `export default ${JSON.stringify({ ...config, options: { ...config.options, tsConfig: { fileName: "tsconfig.json" }, ...(exclude === undefined ? {} : { exclude: { path: exclude } }) } })};`,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "~/*": ["./src/*"], "@/*": ["./src/*"] } },
    }),
  };
  try {
    for (const [path, source] of Object.entries(fixtureFiles)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const result = spawnSync(
      "bun",
      [join(toolsRoot, entrypoint), root, "src", ...(publication ? ["--publication"] : [])],
      {
        encoding: "utf8",
      }
    );
    assert.equal(result.error, undefined);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

await test("resolved aliases and type-only imports obey Core to Shell direction", () => {
  const result = inspect("server", {
    "src/core/example/contract.ts":
      'import type { Value } from "~/shell/example/contract"; export type Result = Value;',
    "src/shell/example/contract.ts": "export type Value = string;",
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /core-imports-platform: src\/core\/example\/contract.ts/);
});

await test("published imports pass while foreign private imports fail", () => {
  const files = {
    "src/core/source/operations.ts":
      'import { read } from "~/core/target/operations"; export const value = read();',
    "src/core/target/operations.ts":
      'import { value } from "~/core/target/internal/value"; export const read = () => value;',
    "src/core/target/internal/value.ts": "export const value = 1;",
  };
  assert.equal(inspect("server", files).status, 0);
  const rejected = inspect("server", {
    ...files,
    "src/core/source/operations.ts":
      'import { value } from "~/core/target/internal/value"; export const read = () => value;',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.output, /published-only: src\/core\/source\/operations.ts/);
});

await test("publication is checked separately from legal owner-private imports", () => {
  const files = {
    "src/core/example/operations.ts":
      'import { read } from "~/core/example/internal/read"; export const exposed = read;',
    "src/core/example/internal/read.ts": "export const read = () => 1;",
  };
  assert.equal(inspect("server", files).status, 0);
  const rejected = inspect("server", files, { entrypoint: "check-publication.mjs" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.output, /published-interface-reexports-internal/);
  const combined = inspect("server", files, { publication: true });
  assert.equal(combined.status, 1);
  assert.match(combined.output, /published-interface-reexports-internal/);
  assert.equal(
    inspect(
      "server",
      { "src/core/example/operations.ts": "export const read = () => 1;" },
      { publication: true }
    ).status,
    0
  );
});

await test("empty, incomplete and unresolved graphs cannot pass either command", () => {
  for (const entrypoint of ["run.mjs", "check-publication.mjs"]) {
    /** @type {Array<[Record<string, string>, string | undefined, RegExp]>} */
    const cases = [
      [{ "src/.keep": "" }, undefined, /cruised 0 modules/],
      [
        {
          "src/core/example/operations.ts": "export const value = 1;",
          "src/core/target/contract.ts": "export type Value = string;",
        },
        "operations",
        /omitted source inputs/,
      ],
      [
        {
          "src/core/example/operations.ts":
            'import { missing } from "./missing"; export const value = missing;',
        },
        undefined,
        /unresolved-dependency/,
      ],
    ];
    for (const [files, exclude, diagnostic] of cases) {
      const result = inspect("server", files, { entrypoint, exclude });
      assert.equal(result.status, 1);
      assert.match(result.output, diagnostic);
    }
  }
});

await test("the web command enforces feature privacy and permits feature publication", () => {
  const files = {
    "src/app/routes.tsx":
      'import { value } from "@/features/example/feature"; export const route = value;',
    "src/features/example/feature.tsx": "export const value = 1;",
    "src/features/example/internal/value.ts": "export const value = 1;",
  };
  assert.equal(inspect("web", files).status, 0);
  const rejected = inspect("web", {
    ...files,
    "src/app/routes.tsx":
      'import { value } from "@/features/example/internal/value"; export const route = value;',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.output, /application-imports-feature-private/);
});

await test("ordinary provider files cannot bypass transport or inference through package submodules", () => {
  const result = inspect("server", {
    "node_modules/effect/package.json": JSON.stringify({
      name: "effect",
      exports: { "./*": "./dist/*.js" },
    }),
    "node_modules/effect/dist/http/HttpClient.js": "export const client = 1;",
    "node_modules/effect/dist/ai/LanguageModel.js": "export const model = 1;",
    "src/shell/channels/whatsapp/internal/adapter.ts":
      'import { client } from "effect/http/HttpClient"; export const transport = client;',
    "src/shell/memory/internal/summary.ts":
      'import { model } from "effect/ai/LanguageModel"; export const inference = model;',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /provider-callers-import-raw-http: src\/shell\/channels\/whatsapp\/internal\/adapter.ts/
  );
  assert.match(
    result.output,
    /hosted-inference-orchestration-imports-provider: src\/shell\/memory\/internal\/summary.ts/
  );
});
