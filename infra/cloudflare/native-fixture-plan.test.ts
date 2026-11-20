import type { describePlan } from "alchemy/Plan";
import { expect, it } from "vitest";
import { requireFixtureLifecycle } from "./native-fixture-plan";
import { nativeResourceInventory } from "./native-graph";
import provider from "./native-retained-provider.json" with { type: "json" };

const revision = "a".repeat(40);
type Row = ReturnType<typeof describePlan>["resources"][number];
const row = (logicalId: string, resourceType: string, action: Row["action"]): Row => ({
  logicalId,
  resourceType,
  action,
  fqn: logicalId,
  bindings: [],
});
const validate = (rows: readonly Row[], fallback: boolean): void =>
  requireFixtureLifecycle({ rows, revision, fallback });
const retained = [...nativeResourceInventory(provider.revision)]
  .filter(([id]) => id.includes(provider.revision))
  .map(([id, type]) => row(id, type, "delete"));
const creation = [...nativeResourceInventory(revision)]
  .filter(([id]) => id.includes(revision))
  .map(([id, type]) => row(id, type, "create"));
it("prepares only this generation's four smoke resources and holds the original generation", () => {
  const approved = [...creation, ...retained, row("Core", "Cloudflare.Worker", "update")];
  expect(() => validate(approved, true)).not.toThrow();
  for (const foreign of [
    row("ReleaseSmokeQueue-" + revision, "Cloudflare.Queues.Queue", "replace"),
    row("ForwardedEmailQueue", "Cloudflare.Queues.Queue", "update"),
    row("ApprovedIngestSamples", "Cloudflare.R2.Bucket", "delete"),
    row("AnotherCore", "Cloudflare.Worker", "create"),
  ]) {
    expect(() => validate([...approved, foreign], true)).toThrow();
  }
  for (const missing of [...creation, ...retained]) {
    expect(() =>
      validate(
        approved.filter((item) => item !== missing),
        true
      )
    ).toThrow();
  }
});
it("uploads only code to the prepared pair and refuses a new provider or resource", () => {
  const active = [
    ...retained,
    row("Core", "Cloudflare.Worker", "update"),
    row("Ingress", "Cloudflare.Worker", "update"),
  ];
  expect(() => validate(active, false)).not.toThrow();
  for (const extra of [...creation, row("Web", "Cloudflare.Worker", "update")]) {
    expect(() => validate([...active, extra], false)).toThrow();
  }
});
