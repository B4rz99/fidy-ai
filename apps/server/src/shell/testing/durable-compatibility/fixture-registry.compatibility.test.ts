import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  durableWorkflowFixtureNames,
  loadDurableWorkflowFixture,
  productionDurableCallCounts,
  productionWorkflowTags,
  unsupportedDeferredCompletions,
} from "~/shell/testing/durable-compatibility";

const testsDirectory = fileURLToPath(new URL(".", import.meta.url));

const expectedDurableCallCounts = {
  "shell/channels/whatsapp/disclosure-delivery.ts:activity": 2,
  "shell/channels/whatsapp/disclosure-delivery.ts:deferredAwait": 2,
  "shell/channels/whatsapp/disclosure-delivery.ts:deferredRace": 2,
  "shell/channels/whatsapp/disclosure-delivery.ts:sleepUntil": 3,
  "shell/channels/whatsapp/disclosure-workflow.ts:deferredMake": 1,
  "shell/channels/whatsapp/disclosure-workflow.ts:queue": 2,
  "shell/channels/whatsapp/inbound-execution.ts:queue": 1,
  "shell/durable-execution-clock.ts:clock": 2,
  "shell/email-authentication/authentication-delivery-worker.ts:activity": 3,
  "shell/email-authentication/authentication-delivery-worker.ts:sleepUntil": 2,
  "shell/email-authentication/pairing-email-execution.ts:queue": 3,
  "shell/email-authentication/replacement-protocol.ts:queue": 2,
  "shell/email-authentication/replacement-workflow.ts:activity": 2,
  "shell/email-authentication/replacement-workflow.ts:sleepFor": 2,
  "shell/email-authentication/replacement-workflow.ts:sleepUntil": 1,
  "shell/ingestion/forwarded-email-execution.ts:queue": 1,
  "shell/ingestion/forwarded-email-workflow.ts:activity": 8,
  "shell/ingestion/forwarded-email-workflow.ts:clock": 1,
  "shell/ingestion/forwarded-email-workflow.ts:sleepUntil": 2,
  "shell/ingestion/worker.ts:queue": 1,
  "shell/onboarding/delivery-workflow.ts:activity": 1,
  "shell/onboarding/delivery-workflow.ts:queue": 1,
  "shell/subscription/billing-attempt-execution.ts:activity": 2,
  "shell/subscription/billing-attempt-execution.ts:clock": 1,
  "shell/subscription/billing-attempt-execution.ts:queue": 1,
};

describe("durable Workflow fixture registry", () => {
  it("rejects production durable declarations omitted from the fixture manifests", () => {
    expect(productionDurableCallCounts).toEqual(expectedDurableCallCounts);
  });

  it("rejects deferred completion forms without fixtures", () => {
    expect(unsupportedDeferredCompletions).toEqual([]);
  });

  it("covers each production Workflow tag with exactly one fixture", () => {
    const tags = durableWorkflowFixtureNames.map(
      (name) => loadDurableWorkflowFixture(name).workflow.tag
    );

    expect(new Set(tags).size, "each fixture declares a distinct Workflow tag").toBe(tags.length);
    expect([...tags].sort(), "fixtures match the production Workflow tags").toEqual([
      ...productionWorkflowTags,
    ]);
  });

  it("loads and asserts every fixture from exactly one dedicated compatibility test", () => {
    const sources = [
      ...new Bun.Glob("*.compatibility.test.ts").scanSync({ cwd: testsDirectory }),
    ].map((file) => ({
      file,
      compact: readFileSync(`${testsDirectory}${file}`, "utf8").replace(/\s+/g, ""),
    }));
    for (const name of durableWorkflowFixtureNames) {
      const owners = sources.filter(({ compact }) =>
        compact.includes(`assertDurableWorkflowFixture(loadDurableWorkflowFixture("${name}")`)
      );
      expect(
        owners.map(({ file }) => file),
        `fixture ${name} has exactly one compatibility test that loads and asserts it`
      ).toHaveLength(1);
    }
    const skipped = sources.filter(({ compact }) =>
      /(?:it|test|describe)\.(?:effect\.)?(?:skip|only|todo|skipIf|runIf)\(/.test(compact)
    );
    expect(
      skipped.map(({ file }) => file),
      "no compatibility test or suite is skipped or focused"
    ).toEqual([]);
  });
});
