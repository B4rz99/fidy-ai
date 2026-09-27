import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import effectGuards from "./effect-guards.js";

const routeFile = fileURLToPath(new URL("../../apps/web/src/app/routes.ts", import.meta.url));
const publicSiteFile = fileURLToPath(
  new URL("../../apps/web/src/features/public-site/feature.tsx", import.meta.url)
);
const otherFile = fileURLToPath(new URL("../../apps/web/src/app/other.ts", import.meta.url));
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("effect-guards/no-ordinary-interface", effectGuards.rules["no-ordinary-interface"], {
  valid: [
    { code: "type Status = { readonly current: boolean };", filename: otherFile },
    {
      code: 'export {}; declare module "@tanstack/react-router" { interface Register { router: string } }',
      filename: routeFile,
    },
  ],
  invalid: [
    {
      code: "interface Status { readonly current: boolean }",
      filename: otherFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: "interface Status { readonly current: boolean }",
      filename: routeFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: 'export {}; declare module "@tanstack/react-router" { interface Register { router: string } interface Extra { value: string } }',
      filename: routeFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: 'export {}; declare module "@tanstack/react-router" { interface Register { router: string } interface Register { extra: string } }',
      filename: routeFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: 'export {}; declare module "other-router" { interface Register { router: string } }',
      filename: routeFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: "export {}; namespace Router { interface Register { router: string } }",
      filename: routeFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
    {
      code: 'export {}; declare module "@tanstack/react-router" { interface Register { router: string } }',
      filename: otherFile,
      errors: [{ messageId: "ordinaryInterface" }],
    },
  ],
});

tester.run(
  "effect-guards/require-route-return-type",
  effectGuards.rules["require-route-return-type"],
  {
    valid: [
      { code: "export const createWebRouter = () => 1;", filename: routeFile },
      { code: "export const createPublicSiteRoute = () => 1;", filename: publicSiteFile },
      { code: "const local = (): number => 1;", filename: routeFile },
      { code: "const values = [1].map((value) => value + 1);", filename: publicSiteFile },
    ],
    invalid: [
      {
        code: "export const unrelated = () => 1;",
        filename: routeFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "const helper = () => 1;",
        filename: publicSiteFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "export const createWebRouter = () => 1;",
        filename: otherFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "const createWebRouter = () => 1;",
        filename: routeFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "export function helper() { return 1; }",
        filename: routeFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "const helper = function () { return 1; };",
        filename: publicSiteFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "export const createWebRouter = () => 1; { const createWebRouter = () => 2; }",
        filename: routeFile,
        errors: [{ messageId: "routeReturnType" }],
      },
    ],
  }
);

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
