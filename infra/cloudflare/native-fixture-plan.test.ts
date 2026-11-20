import type { describePlan } from "alchemy/Plan";
import { expect, it } from "vitest";
import { nativePlanOptions, requireFixtureLifecycle } from "./native-fixture-plan";
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
const validate = (rows: readonly Row[], fallback = false): void =>
  requireFixtureLifecycle({ rows, fallback });
const retained = [...nativeResourceInventory(provider.revision)]
  .filter(([id]) => id.includes(provider.revision))
  .map(([id, type]) => row(id, type, "delete"));
const creation = [...nativeResourceInventory(revision)]
  .filter(([id]) => id.includes(revision))
  .map(([id, type]) => row(id, type, "create"));
it("updates only the repaired pair and its existing smoke executor on the captured installation", () => {
  const approved = [
    ...retained,
    row("ReleaseSmoke-aa447b8b781cdda48e021c1332f4377eae00f179", "Cloudflare.Worker", "update"),
    row("Core", "Cloudflare.Worker", "update"),
    row("Ingress", "Cloudflare.Worker", "update"),
  ];
  expect(() => validate(approved, true)).not.toThrow();
  for (const foreign of [
    ...creation,
    row("Web", "Cloudflare.Worker", "update"),
    row("ForwardedEmail", "Cloudflare.Worker", "update"),
    row("ForwardedEmailQueue", "Cloudflare.Queues.Queue", "update"),
  ]) {
    expect(() => validate([...approved, foreign], true)).toThrow();
  }
  for (const missing of approved) {
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
  expect(() => validate(active)).not.toThrow();
  for (const extra of [...creation, row("Web", "Cloudflare.Worker", "update")]) {
    expect(() => validate([...active, extra])).toThrow();
  }
});

it("uses the existing Alchemy state Worker for preview and apply of a signed release", () => {
  for (const preview of [true, false]) {
    expect(
      nativePlanOptions({ profile: "ci", preview, fingerprint: "a".repeat(64) }).updateStateStore
    ).toBe(false);
  }
  expect(
    nativePlanOptions({ profile: "ci", preview: false, fingerprint: "" }).updateStateStore
  ).toBe(true);
});
