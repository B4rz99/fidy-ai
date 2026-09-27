import { expect, it } from "vitest";
import { suppressionsIn } from "./check-lint-suppressions";

const effectDirective = (suffix: string): string => `// @effect${suffix}`;

it("rejects a one-line Effect diagnostic opt-out in application source", () => {
  const source = effectDirective("-diagnostics-next-line asyncFunction:off");

  expect(
    suppressionsIn({
      file: "apps/server/cloudflare/worker.ts",
      contents: `const ok = true;\n${source}\n`,
    })
  ).toEqual([{ file: "apps/server/cloudflare/worker.ts", line: 2, source }]);
});

it("rejects a file-scoped Effect diagnostic opt-out", () => {
  const source = effectDirective("-diagnostics asyncFunction:off");

  expect(
    suppressionsIn({ file: "apps/server/cloudflare/worker.ts", contents: `${source}\n` })
  ).toEqual([{ file: "apps/server/cloudflare/worker.ts", line: 1, source }]);
});

it("rejects both Oxlint and ESLint directives", () => {
  const sources = [
    "// oxlint" + "-disable-next-line no-console",
    "// eslint" + "-disable no-console",
  ];

  expect(suppressionsIn({ file: "scripts/runner.ts", contents: sources.join("\n") })).toEqual(
    sources.map((source, index) => ({ file: "scripts/runner.ts", line: index + 1, source }))
  );
});

it("rejects disabled async diagnostics in TypeScript configs without flagging regular source text", () => {
  const source = '"asyncFunction": "off",';

  expect(suppressionsIn({ file: "tsconfig.base.json", contents: `  ${source}` })).toEqual([
    { file: "tsconfig.base.json", line: 1, source },
  ]);
  expect(suppressionsIn({ file: "scripts/runner.ts", contents: source })).toEqual([]);
});
