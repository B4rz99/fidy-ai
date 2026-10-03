import assert from "node:assert/strict";
import test from "node:test";
import { publicationViolations } from "./publication.mjs";

/** @param {string} from - Caller. @param {string} to - Exact resolved target. */
const inspect = (from, to) =>
  publicationViolations(
    {
      modules: [
        { source: from, dependencies: [{ resolved: to }] },
        { source: to, dependencies: [] },
        { source: "cloudflare/source/contract.ts", dependencies: [] },
        { source: "cloudflare/target/contract.ts", dependencies: [] },
      ],
    },
    "/synthetic/apps/server"
  );

await test("a Trio filename under another owner's internals is still private", () => {
  for (const role of ["contract", "operations", "runtime"]) {
    const from = "cloudflare/source/runtime.ts";
    const to = `cloudflare/target/internal/${role}.ts`;
    assert.equal(
      inspect(from, to).some(
        (violation) =>
          violation.name === "published-only" && violation.from === from && violation.to === to
      ),
      true
    );
  }
});

await test("portable declarations cannot acquire native virtual platform types", () => {
  for (const layer of ["core", "shell"]) {
    const from = `src/${layer}/example/contract.ts`;
    assert.equal(
      inspect(from, "cloudflare:workers").some(
        (violation) => violation.name === "portable-imports-platform"
      ),
      true
    );
  }
});

await test("the registered catalog generation composition can use owner runtime authority", () => {
  assert.deepEqual(
    inspect("tools/email-formats/generate-runtime.ts", "src/shell/ingestion/runtime.ts"),
    []
  );
});

await test("enrollment acceptance earns only named test-composition authority", () => {
  const enrollment = "cloudflare/subscription/payment-enrollment.test.ts";
  const runtime = "cloudflare/core-http/runtime.ts";
  assert.deepEqual(inspect(enrollment, runtime), []);
  assert.equal(
    inspect("cloudflare/subscription/ordinary.test.ts", runtime).some(
      (violation) => violation.name === "runtime-outside-composition"
    ),
    true
  );
  assert.equal(
    inspect("cloudflare/core-worker.ts", enrollment).some(
      (violation) => violation.name === "production-imports-test-code"
    ),
    true
  );
});

await test("a private runtime filename does not make its importer a composition root", () => {
  assert.equal(
    inspect("cloudflare/source/internal/runtime.ts", "cloudflare/target/runtime.ts").some(
      (violation) => violation.name === "runtime-outside-composition"
    ),
    true
  );
});

await test("an approved production root cannot import an approved integration test", () => {
  assert.equal(
    inspect("cloudflare/core-worker.ts", "cloudflare/onboarding/verified-onboarding.test.ts").some(
      (violation) => violation.name === "production-imports-test-code"
    ),
    true
  );
});

await test("production roots cannot import the synthetic resource-admission Worker fixture", () => {
  assert.equal(
    inspect(
      "cloudflare/core-worker.ts",
      "cloudflare/resource-admission/resource-admission-worker.fixture.ts"
    ).some((violation) => violation.name === "production-imports-test-code"),
    true
  );
});

await test("owned code cannot escape publication through unowned source or repository helpers", () => {
  for (const from of [
    "src/core/example/operations.ts",
    "src/shell/example/operations.ts",
    "cloudflare/source/runtime.ts",
  ]) {
    for (const to of ["src/rogue/helper.ts", "../../scripts/helper.ts", "tools/helper.mjs"]) {
      assert.equal(
        inspect(from, to).some((violation) => violation.name === "published-only"),
        true,
        `${from} must reject ${to}`
      );
    }
  }
});
