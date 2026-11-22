import type { describePlan } from "alchemy/Plan";
import { expect, it } from "vitest";
import {
  nativePlanOptions,
  projectFixtureInventory,
  requireActiveSuccessorLifecycle,
  requireFixtureLifecycle,
  requireSameSuccessorPlan,
  requireSmokeConsumerReconciliation,
  requireSuccessorLifecycle,
} from "./native-fixture-plan";
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

const retained = [...nativeResourceInventory(provider.revision)].flatMap(([id, type]) =>
  id.includes(provider.revision) ? [row(id, type, "delete")] : []
);

const creation = [...nativeResourceInventory(revision)].flatMap(([id, type]) =>
  id.includes(revision) ? [row(id, type, "create")] : []
);

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

it("projects only known resource and action names from a refused inventory", () => {
  const rows = [
    row("Web", "Cloudflare.Worker", "update"),
    row("private-tenant", "private-type", "create"),
    { ...row("Core", "private-type", "update"), fqn: "private-coordinate" },
    row("Build", "Command.Build", "noop"),
  ];

  const observed = projectFixtureInventory(rows);
  expect(observed).toEqual([
    { action: "update", logicalId: "Web", resourceType: "Cloudflare.Worker" },
    { action: "create", logicalId: "unrecognized", resourceType: "unrecognized" },
    { action: "update", logicalId: "unrecognized", resourceType: "unrecognized" },
    { action: "noop", logicalId: "Build", resourceType: "Command.Build" },
  ]);
});

it("allows only the two existing Workers and four new smoke resources in the successor plan", () => {
  const pair = [
    row("Core", "Cloudflare.Worker", "update"),
    row("Ingress", "Cloudflare.Worker", "update"),
  ];

  const rows = [...pair, ...creation];
  expect(() => requireSuccessorLifecycle({ rows, revision })).not.toThrow();

  for (const foreign of [
    ...retained,
    row("Web", "Cloudflare.Worker", "update"),
    row("ForwardedEmail", "Cloudflare.Worker", "update"),
    row("ReleaseSmoke-aa447b8b781cdda48e021c1332f4377eae00f179", "Cloudflare.Worker", "update"),
    row("Core", "Cloudflare.R2.Bucket", "update"),
  ]) {
    expect(() => requireSuccessorLifecycle({ rows: [...rows, foreign], revision })).toThrow();
  }

  for (const missing of rows) {
    expect(() =>
      requireSuccessorLifecycle({
        rows: rows.filter((item) => item !== missing),
        revision,
      })
    ).toThrow();
  }
});

it("allows the same plan in provider order and rejects changes before any upload", () => {
  const plan = {
    revision,
    applied: false,
    member: "performance-2",
    resources: [...creation, row("Core", "Cloudflare.Worker", "update")],
  };

  expect(() =>
    requireSameSuccessorPlan({
      approved: plan,
      observed: { ...plan, resources: [...plan.resources].reverse() },
    })
  ).not.toThrow();

  for (const changed of [
    { ...plan, revision: provider.revision },
    { ...plan, applied: true },
    { ...plan, resources: creation },
    { ...plan, resources: [...plan.resources, row("Web", "Cloudflare.Worker", "update")] },
  ]) {
    expect(() => requireSameSuccessorPlan({ approved: plan, observed: changed })).toThrow();
  }
});

it("keeps the successor smoke generation and every other resource unchanged for the active pair", () => {
  const existing = creation.map((entry) => ({ ...entry, action: "noop" as const }));

  const active = [
    ...existing,
    row("Core", "Cloudflare.Worker", "update"),
    row("Ingress", "Cloudflare.Worker", "update"),
  ];

  expect(() => requireActiveSuccessorLifecycle({ rows: active, revision })).not.toThrow();
  expect(() => requireActiveSuccessorLifecycle({ rows: active.slice(1), revision })).toThrow();

  for (const unexpected of creation) {
    expect(() =>
      requireActiveSuccessorLifecycle({
        rows: active.map((entry) =>
          entry.logicalId === unexpected.logicalId ? unexpected : entry
        ),
        revision,
      })
    ).toThrow();
  }
});

it("permits reconciliation of the sole Smoke consumer only against unchanged upstream resources", () => {
  const consumer = row("ReleaseSmokeConsumer-" + revision, "Cloudflare.Queues.Consumer", "create");
  const queue = row("ReleaseSmokeQueue-" + revision, "Cloudflare.Queues.Queue", "noop");
  const worker = row("ReleaseSmoke-" + revision, "Cloudflare.Worker", "noop");

  const verify = (rows: readonly Row[]): string =>
    requireSmokeConsumerReconciliation({ rows, revision });

  expect(verify([consumer, queue, worker])).toBe("create");
  expect(verify([{ ...consumer, action: "noop" }, queue, worker])).toBe("noop");

  for (const rows of [
    [consumer, queue],
    [consumer, { ...queue, action: "update" }, worker],
    [consumer, queue, worker, row("Core", "Cloudflare.Worker", "update")],
    [consumer, queue, worker, consumer],
    [{ ...consumer, action: "replace" }, queue, worker],
  ] as const) {
    expect(() => verify(rows)).toThrow();
  }
});
