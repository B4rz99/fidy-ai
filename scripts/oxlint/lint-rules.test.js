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
import testGuards from "./test-guards.js";
import effectRecovery from "./effect-recovery.js";

const routeFile = fileURLToPath(new URL("../../apps/web/src/app/routes.ts", import.meta.url));
const otherFile = fileURLToPath(new URL("../../apps/web/src/app/other.ts", import.meta.url));
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("effect-recovery/no-catch-succeed-none", effectRecovery.rules["no-catch-succeed-none"], {
  valid: [
    'import { Effect, Option } from "effect"; work.pipe(Effect.orElseSucceed(Option.none));',
    'import { Effect } from "effect"; Effect.catch(() => Effect.succeed(1));',
    'import { Effect } from "effect"; Effect.catch(() => { observe(); return Effect.succeedNone; });',
    'import { Effect } from "effect"; Effect.catch((failure) => Effect.succeedNone);',
    'import { Effect } from "effect"; Effect.catch(async () => Effect.succeedNone);',
    'import { Effect } from "effect"; Effect.catch(() => other.succeedNone);',
    'import { Effect } from "effect"; other.catch(() => Effect.succeedNone);',
    'import { Effect } from "effect"; function inspect(Effect) { Effect.catch(() => Effect.succeedNone); }',
    'import { Effect } from "effect"; Effect.catch(() => { const Effect = other; return Effect.succeedNone; });',
    'import { Effect } from "other"; Effect.catch(() => Effect.succeedNone);',
    "const Effect = other; Effect.catch(() => Effect.succeedNone);",
    "Effect.catch(() => Effect.succeedNone);",
    'import { Effect } from "effect"; Effect.catch(() => Effect[method]);',
    'import type { Effect } from "effect"; Effect.catch(() => Effect.succeedNone);',
  ],
  invalid: [
    'import { Effect } from "effect"; work.pipe(Effect.catch(() => Effect.succeedNone));',
    'import { Effect as Fx } from "effect"; Fx.catch(work, () => Fx.succeedNone);',
    'import * as Fx from "effect/Effect"; Fx.catch(() => Fx.succeedNone);',
    'import { catch as recover, succeedNone as empty } from "effect/Effect"; recover(() => empty);',
    'import { Effect } from "effect"; Effect["catch"](() => Effect["succeedNone"]);',
  ].map((code) => ({ code, errors: [{ messageId: "catchSucceedNone" }] })),
});

tester.run("test-guards/no-tsx-tests", testGuards.rules["no-tsx-tests"], {
  valid: [
    { code: "export {};", filename: "policy.test.ts" },
    { code: "export {};", filename: "feature.tsx" },
    { code: "export {};", filename: "journey.spec.ts" },
  ],
  invalid: [
    { code: "", filename: "feature.test.tsx", errors: [{ messageId: "tsxTest" }] },
    {
      code: "export {};",
      filename: "/workspace/apps/web/src/nested/feature.test.tsx",
      errors: [{ messageId: "tsxTest" }],
    },
  ],
});

tester.run("test-guards/no-module-mocks", testGuards.rules["no-module-mocks"], {
  valid: [
    'import { vi } from "vitest"; vi.fn(); vi.mocked(callback);',
    'import { vi } from "vitest"; vi.spyOn(globalThis, "fetch");',
    'import { mock } from "bun:test"; mock(() => 1);',
    'import { vi } from "vitest"; function check(vi) { vi.mock("data"); }',
    'const vi = { mock() {} }; vi.mock("data");',
    'import { Layer } from "effect"; Layer.succeed(Service, fixture);',
    'const cycle = cycle; cycle.mock("data");',
  ],
  invalid: [
    'import { vi } from "vitest"; vi.mock("./owner", () => ({}));',
    'import { vi as replacement } from "vitest"; replacement.doMock("./owner");',
    'import * as tests from "vitest"; tests.vi["mock"]("./owner");',
    'import { vi } from "vitest"; const replacement = vi; replacement.mock("./owner");',
    'import { vi } from "vitest"; const { mock: replace } = vi; replace("./owner");',
    'import { vi } from "vitest"; const replace = vi.doMock; replace("./owner");',
    'import { jest as tests } from "@jest/globals"; tests.mock("./owner");',
    'import { jest } from "@jest/globals"; jest.unstable_mockModule("./owner", () => ({}));',
    'import { mock as replacement } from "bun:test"; replacement.module("./owner", () => ({}));',
    'import { mock } from "node:test"; mock.module("./owner", {});',
    'const { vi } = require("vitest"); vi.mock("./owner");',
    'const { vi } = await import("vitest"); vi.mock("./owner");',
    'vi.mock("./owner");',
    'jest.doMock("./owner");',
  ].map((code) => ({ code, errors: [{ messageId: "moduleMock" }] })),
});

tester.run("test-guards/no-react-test-tools", testGuards.rules["no-react-test-tools"], {
  valid: [
    'import { test } from "@playwright/test";',
    'import { createRoot } from "react-dom/client";',
    'import { it } from "@effect/vitest";',
    'import { RegistryProvider } from "@effect/atom-react";',
    'import fixture from "./react-test-renderer-fixture";',
  ],
  invalid: [
    'import { render } from "@testing-library/react";',
    'import "@testing-library/jest-dom/vitest";',
    'import renderer from "react-test-renderer";',
    'import { act } from "react-dom/test-utils";',
    'export { render } from "@testing-library/react";',
    'export * from "enzyme";',
    'const renderer = await import("react-test-renderer/shallow");',
    'const { render } = require("@testing-library/react");',
    'import { render } from "@vitest/browser-react";',
  ].map((code) => ({ code, errors: [{ messageId: "reactTestTool" }] })),
});

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
      errors: [{ message: /aliases cannot be reopened by declaration merging/u }],
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

tester.run("effect-guards/no-react-use-effect", effectGuards.rules["no-react-use-effect"], {
  valid: [],
  invalid: [
    {
      code: 'import { useEffect } from "react";',
      errors: [{ message: /event handlers.*narrow adapter.*file-scoped exception/u }],
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

tester.run(
  "effect-guards/require-route-return-type",
  effectGuards.rules["require-route-return-type"],
  {
    valid: [
      { code: "export const createWebRouter = () => 1;", filename: routeFile },
      { code: "const local = (): number => 1;", filename: routeFile },
      { code: "const values = [1].map((value) => value + 1);", filename: routeFile },
    ],
    invalid: [
      {
        code: "export const unrelated = () => 1;",
        filename: routeFile,
        errors: [{ messageId: "routeReturnType" }],
      },
      {
        code: "const helper = () => 1;",
        filename: routeFile,
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
        filename: routeFile,
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

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const testProbe = join(workspaceRoot, `apps/web/src/.lint-test-probe-${process.pid}.test.tsx`);
try {
  writeFileSync(
    testProbe,
    'import { vi } from "vitest";\nimport { render } from "@testing-library/react";\nimport { Effect } from "effect";\nvi.mock("./owner", () => ({}));\nEffect.catch(() => Effect.succeedNone);\n'
  );
  const result = spawnSync(
    "./node_modules/.bin/oxlint",
    ["--config", ".oxlintrc.json", testProbe],
    { cwd: workspaceRoot, encoding: "utf8" }
  );
  const report = `${result.stdout}\n${result.stderr}`;
  for (const rule of ["no-tsx-tests", "no-module-mocks", "no-react-test-tools"]) {
    assert.ok(report.includes(`test-guards(${rule})`), report);
  }
  assert.ok(report.includes("effect-recovery(no-catch-succeed-none)"), report);
  assert.notEqual(result.status, 0);
} finally {
  unlinkSync(testProbe);
}

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

const designProbe = join(workspaceRoot, "apps/web/src/app/.lint-design-probe.tsx");
const designCases = [
  { expression: '<Alert className="bg-success-subtle" />', rule: "no-restyle" },
  { expression: '<Alert variant="success">Guardado</Alert>' },
  { expression: '<div className="bg-[#88CC20]" />', rule: "no-arbitrary-values" },
  {
    expression: '<Button className="active:bg-primary-pressed">Guardar</Button>',
    rule: "no-restyle",
  },
  { expression: '<Button className="disabled:opacity-50">Guardar</Button>', rule: "no-restyle" },
  { expression: '<div className="bg-success-subtle text-success-foreground" />' },
  { expression: '<div className="border-control-border text-link" />' },
  { expression: '<div className="bg-blue-500" />', rule: "no-raw-colors" },
  { expression: '<div className={cn("text-[#123456]")} />', rule: "no-arbitrary-values" },
  { expression: '<Button className="bg-secondary">Guardar</Button>', rule: "no-restyle" },
  { expression: '<Button className="p-4">Guardar</Button>', rule: "no-restyle" },
  { expression: '<Button className="focus-visible:ring-0">Guardar</Button>', rule: "no-restyle" },
  { expression: '<Badge className="bg-secondary">Activo</Badge>', rule: "no-restyle" },
  { expression: '<TableRow className="hover:bg-secondary" />', rule: "no-restyle" },
  { expression: '<div style={{ color: "red" }} />', rule: "no-inline-styles" },
  { expression: '<div className="rounded-fidy-typo" />', rule: "no-unknown-classes" },
  { expression: "<Button className={String(1)}>Guardar</Button>", rule: "require-static-classes" },
  { expression: '<Badge variant="success">Activo</Badge>' },
  { expression: '<TableRow interaction="clickable" />' },
  { expression: '<Button variant="outline" className="w-full">Guardar</Button>' },
  { expression: '<CardContent className="flex gap-4 px-6">Contenido</CardContent>' },
];
try {
  for (const { expression, rule } of designCases) {
    writeFileSync(
      designProbe,
      `import type { JSX } from "react";\n` +
        (expression.includes("Button")
          ? `import { Button } from "@/ui/components/button";\n`
          : "") +
        (expression.includes("Alert") ? `import { Alert } from "@/ui/components/alert";\n` : "") +
        (expression.includes("Badge") ? `import { Badge } from "@/ui/components/badge";\n` : "") +
        (expression.includes("TableRow")
          ? `import { TableRow } from "@/ui/components/table";\n`
          : "") +
        (expression.includes("CardContent")
          ? `import { CardContent } from "@/ui/components/card";\n`
          : "") +
        (expression.includes("cn(") ? `import { cn } from "@/ui/class-names";\n` : "") +
        "\n" +
        `export const DesignProbe = (): JSX.Element => ${expression};\n`
    );
    const result = spawnSync(
      "./node_modules/.bin/oxlint",
      ["--config", ".oxlintrc.json", designProbe],
      { cwd: workspaceRoot, encoding: "utf8" }
    );
    const report = `${result.stdout}\n${result.stderr}`;
    if (rule) {
      assert.ok(report.includes(`shadcn(${rule})`), report);
      assert.notEqual(result.status, 0);
    } else {
      assert.equal(result.status, 0, report);
    }
  }
} finally {
  unlinkSync(designProbe);
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "fidy-symbol-guidance-"));
try {
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
