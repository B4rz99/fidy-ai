import { Schema } from "effect";
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

it("rejects disabled diagnostics that no longer require TypeScript path overrides", () => {
  const sources = [
    '"asyncFunction": "off",',
    '"globalFetch": "off",',
    '"missingPipeableSignature": "off",',
    '"newPromise": "off",',
    '"strictBooleanExpressions": "off",',
  ];

  expect(suppressionsIn({ file: "tsconfig.base.json", contents: sources.join("\n") })).toEqual(
    sources.map((source, index) => ({ file: "tsconfig.base.json", line: index + 1, source }))
  );
  expect(suppressionsIn({ file: "scripts/runner.ts", contents: sources.join("\n") })).toEqual([]);
});

it("allows a narrow platform diagnostic override", () => {
  expect(
    suppressionsIn({
      file: "tsconfig.base.json",
      contents: '"nodeBuiltinImport": "off",',
    })
  ).toEqual([]);
});

const TypeScriptExceptions = Schema.Struct({
  compilerOptions: Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({
        overrides: Schema.Array(
          Schema.Struct({
            include: Schema.Array(Schema.String),
            options: Schema.Struct({
              diagnosticSeverity: Schema.Record(Schema.String, Schema.String),
            }),
          })
        ),
      })
    ),
  }),
});

const OxlintExceptions = Schema.Struct({
  overrides: Schema.Array(
    Schema.Struct({
      files: Schema.Array(Schema.String),
      rules: Schema.Record(Schema.String, Schema.Unknown),
    })
  ),
});

const disabledFor = ({
  include,
  options,
}: Readonly<{
  include: ReadonlyArray<string>;
  options: Readonly<{ diagnosticSeverity: Readonly<Record<string, string>> }>;
}>): ReadonlyArray<string> =>
  Object.entries(options.diagnosticSeverity).flatMap(([rule, severity]) =>
    severity === "off" ? include.map((file) => `${rule}:${file}`) : []
  );

it("keeps platform diagnostic opt-outs on their reviewed file boundaries", () =>
  Bun.file(new URL("../tsconfig.base.json", import.meta.url))
    .json()
    .then((value: unknown) => Schema.decodeUnknownSync(TypeScriptExceptions)(value))
    .then(({ compilerOptions }) => {
      const exceptions = compilerOptions.plugins.flatMap(({ overrides }) =>
        overrides.flatMap(disabledFor)
      );
      expect(exceptions.toSorted()).toEqual(
        [
          "nodeBuiltinImport:./apps/web/cloudflare/production-policy/artifact.ts",
          "nodeBuiltinImport:./apps/web/scripts/build-production.test.ts",
          "nodeBuiltinImport:./apps/web/scripts/check-browser-bundle.test.ts",
          "nodeBuiltinImport:./scripts/document-parsing/check.ts",
          "nodeBuiltinImport:./scripts/document-parsing/extraction-proof.ts",
          "nodeBuiltinImport:./scripts/document-parsing/protected-document-proof.ts",
          "processEnv:./apps/web/playwright.config.ts",
        ].toSorted()
      );
    }));

it("confines unsafe tooling rules to the isolated dependency analyzer", () =>
  Bun.file(new URL("../.oxlintrc.json", import.meta.url))
    .text()
    .then((contents) => Schema.decodeUnknownSync(OxlintExceptions)(Bun.JSONC.parse(contents)))
    .then(({ overrides }) => {
      const unsafeRules = [
        "typescript/no-unsafe-argument",
        "typescript/no-unsafe-assignment",
        "typescript/no-unsafe-call",
        "typescript/no-unsafe-member-access",
        "typescript/no-unsafe-return",
      ];
      const scopes = overrides.flatMap(({ files, rules }) =>
        unsafeRules.flatMap((rule) => (rules[rule] === "off" ? files : []))
      );
      expect(new Set(scopes)).toEqual(new Set(["tools/depcruise/*.mjs"]));
    }));

it("keeps ordered-loop opt-outs scoped and does not re-disable refactored rules", () =>
  Bun.file(new URL("../.oxlintrc.json", import.meta.url))
    .text()
    .then((contents) => Schema.decodeUnknownSync(OxlintExceptions)(Bun.JSONC.parse(contents)))
    .then(({ overrides }) => {
      const sequential = overrides.flatMap(({ files, rules }) =>
        rules["no-await-in-loop"] === "off" ? files : []
      );
      expect(sequential.toSorted()).toEqual(
        [
          "apps/server/scripts/check-dependency-guards.ts",
          "apps/web/scripts/check-dependency-guards.ts",
        ].toSorted()
      );
      expect(overrides.some(({ rules }) => "effect-guards/no-nullable-type" in rules)).toBe(false);
      expect(
        overrides.find(({ files }) =>
          files.includes("apps/server/cloudflare/card-enrollment/card-enrollment.ts")
        )?.rules["max-params"]
      ).toBeUndefined();
      expect(
        overrides.flatMap(({ rules }) =>
          ["max-depth", "max-params"].filter((rule) => rules[rule] === "off")
        )
      ).toEqual([]);
      const refactoredComplexity = new Set([
        "apps/server/tools/contracts/generate.ts",
        "scripts/oxlint/dictionary-types.js",
        "scripts/check-web-design-system.ts",
      ]);
      expect(
        overrides
          .filter(({ files }) => files.some((file) => refactoredComplexity.has(file)))
          .some(({ rules }) => rules["complexity"] === "off")
      ).toBe(false);
    }));
