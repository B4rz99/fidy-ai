import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import effectGuards from "./effect-guards.js";
import foldkitStyle from "./foldkit-style.js";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
tester.run("effect-guards/no-ordinary-interface", effectGuards.rules["no-ordinary-interface"], {
  valid: [{ code: "type Account = {id:string};" }],
  invalid: [
    { code: "interface Account { id:string }", errors: [{ messageId: "ordinaryInterface" }] },
    {
      code: 'export {}; declare module "integration" { interface Register {value:string} }',
      errors: [{ messageId: "ordinaryInterface" }],
    },
  ],
});

tester.run("foldkit-style/semantic-colors", foldkitStyle.rules["semantic-colors"], {
  valid: [
    { code: 'html.Class("bg-primary text-primary-foreground");' },
    {
      code: 'html.Class(`bg-secondary ${selected ? "text-foreground" : "text-muted-foreground"}`);',
    },
    { code: 'html.Class("grid-cols-[1fr_20rem]");' },
  ],
  invalid: [
    { code: 'html.Class("bg-blue-500");', errors: [{ messageId: "semantic" }] },
    { code: 'html.Class("text-[#123456]");', errors: [{ messageId: "semantic" }] },
    { code: "html.Class(`bg-red-500 ${selected}`);", errors: [{ messageId: "semantic" }] },
  ],
});

tester.run("effect-guards/no-effect-promise", effectGuards.rules["no-effect-promise"], {
  valid: [],
  invalid: [
    {
      code: 'import { Effect } from "effect"; Effect.promise(() => Promise.resolve(1));',
      errors: [{ message: /Effect.tryPromise\(\{ try, catch \}\).*Cause.UnknownError/u }],
    },
  ],
});

tester.run("effect-guards/no-type-cast", effectGuards.rules["no-type-cast"], {
  valid: [],
  invalid: [
    {
      code: "Function.cast<unknown, string>(value);",
      errors: [{ message: /owning Schema.*custom guard must actually check/u }],
    },
  ],
});

tester.run("effect-guards/no-nullable-type", effectGuards.rules["no-nullable-type"], {
  valid: [],
  invalid: [
    {
      code: "type Draft = { merged?: boolean };",
      errors: [{ message: /Option.Option<T>.*discriminated union of valid states/u }],
    },
    {
      code: "type Value = string | null;",
      errors: [{ message: /Option.fromNullable.*Schema.OptionFromNullOr/u }],
    },
  ],
});

// Exercise the real lint config as well as the isolated rule: a new source file
// must not escape merely because the old built-in rule was replaced.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const probeFile = fileURLToPath(
  new URL(`../../apps/web/src/app/.lint-interface-probe-${process.pid}.ts`, import.meta.url)
);
try {
  writeFileSync(probeFile, "interface Ordinary { readonly value: string }\n");
  const result = spawnSync(
    "./node_modules/.bin/oxlint",
    ["--config", ".oxlintrc.json", probeFile],
    { cwd: workspaceRoot, encoding: "utf8" }
  );
  assert.match(`${result.stdout}\n${result.stderr}`, /effect-guards\(no-ordinary-interface\)/u);
  assert.notEqual(result.status, 0);
} finally {
  unlinkSync(probeFile);
}

// Run the source guard in an isolated workspace so guidance is exercised without a probe file
// racing the repository's other static checks.
const isolatedRoot = mkdtempSync(join(tmpdir(), "fidy-symbol-guidance-"));
try {
  // The copied guard decodes with Effect before scanning. Keep its installed dependency
  // available without allowing isolated source probes to race the real checkout.
  symlinkSync(join(workspaceRoot, "node_modules"), join(isolatedRoot, "node_modules"), "dir");
  for (const directory of [
    "apps/server/scripts",
    "apps/server/src",
    "apps/server/cloudflare",
    "apps/web/src",
    "infra/cloudflare",
  ]) {
    mkdirSync(join(isolatedRoot, directory), { recursive: true });
  }
  const guardPath = join(isolatedRoot, "apps/server/scripts/check-lint-guards.ts");
  const sourcePath = join(isolatedRoot, "apps/web/src/symbol-probe.ts");
  copyFileSync(
    fileURLToPath(new URL("../../apps/server/scripts/check-lint-guards.ts", import.meta.url)),
    guardPath
  );
  writeFileSync(sourcePath, 'export const nominal = Symbol("nominal");\n');
  const result = spawnSync("bun", [guardPath], { cwd: isolatedRoot, encoding: "utf8" });
  const report = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(report, /symbol-probe\.ts:1: handwritten Symbol/u);
  assert.match(report, /closure-backed behavior.*validate a scalar schema before Schema.brand/u);
  assert.match(report, /brand alone adds no runtime checks.*Symbol.iterator remain allowed/u);
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
