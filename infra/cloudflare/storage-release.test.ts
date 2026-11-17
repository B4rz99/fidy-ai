import {
  installationNames,
  requireAbsentInstallation,
  requireFreshPlan,
  requireInstallationWorker,
} from "./storage-installation";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import {
  buildStorageRelease,
  compatibleStoragePairs,
  namespaceClasses,
  storageOverlap,
  storageReleaseBinding,
  storageReleaseCodec,
  verifiedStoragePair,
} from "./storage-release";

describe("release compatibility for native retained stores", () => {
  it.effect(
    "uses exact histories for all five owners and refuses a changed step or an unreadable protocol",
    () =>
      Effect.gen(function* () {
        const stable = yield* buildStorageRelease();
        expect(Object.keys(stable.histories).sort()).toEqual([
          "directory",
          "erasure",
          "maintenance",
          "pricing",
          "user",
        ]);
        expect(stable.histories.user.length).toBeGreaterThanOrEqual(2);
        expect(storageOverlap({ stable, candidate: stable })).toEqual({
          forward: true,
          rollback: true,
        });
        const appended = {
          ...stable,
          histories: { ...stable.histories, user: [...stable.histories.user, "3".repeat(64)] },
        };
        expect(storageOverlap({ stable, candidate: appended })).toEqual({
          forward: true,
          rollback: false,
        });
        expect(storageOverlap({ stable: appended, candidate: stable })).toEqual({
          forward: false,
          rollback: false,
        });
        const rewritten = {
          ...stable,
          histories: { ...stable.histories, pricing: ["0".repeat(64)] },
        };
        expect(storageOverlap({ stable, candidate: rewritten }).forward).toBe(false);
        const incompatible = { ...stable, protocol: { write: "next", readers: ["next"] } };
        expect(storageOverlap({ stable, candidate: incompatible }).forward).toBe(false);
      })
  );
});

it.effect("checks exact immutable namespace IDs, access and Worker pair descriptors", () =>
  Effect.gen(function* () {
    const description = yield* buildStorageRelease();
    const descriptor = {
      type: "plain_text",
      text: yield* Schema.encodeEffect(storageReleaseCodec)(description),
    };
    const ingress = { [storageReleaseBinding]: descriptor };
    const bindings = Object.fromEntries(
      Object.entries(namespaceClasses).map(([name, class_name]) => [
        name,
        { type: "durable_object_namespace", namespace_id: name, class_name },
      ])
    );
    const core = { ...ingress, ...bindings };
    const actual = verifiedStoragePair({ ingress, core });
    expect(compatibleStoragePairs({ serving: actual, candidate: actual })).toEqual({
      forward: true,
      rollback: true,
    });
    const replaced = verifiedStoragePair({
      ingress,
      core: { ...core, USER_STORE: { ...bindings.USER_STORE, namespace_id: "replacement" } },
    });
    expect(compatibleStoragePairs({ serving: actual, candidate: replaced }).forward).toBe(false);
    expect(() => verifiedStoragePair({ ingress, core: { ...core, DB: { type: "d1" } } })).toThrow();
    expect(() =>
      verifiedStoragePair({ ingress: { ...ingress, PRICING: bindings.PRICING }, core })
    ).toThrow();
    expect(() =>
      verifiedStoragePair({ ingress, core: { ...core, ERASURE: bindings.MAINTENANCE } })
    ).toThrow();
    expect(() => verifiedStoragePair({ ingress: {}, core })).toThrow();
  })
);

it("refuses to bootstrap an existing target or a plan that can replace or delete resources", () => {
  const empty = { scripts: [], namespaces: [], domains: [] };
  expect(() => requireAbsentInstallation(empty)).not.toThrow();
  expect(() =>
    requireAbsentInstallation({
      scripts: [
        { id: "fidycloudflare-ingress-production-hf6ajjsszff23h5z" },
        { id: "fidycloudflare-core-production-hdv5cspnk7fai6vg" },
      ],
      namespaces: [{ script: "fidycloudflare-core-production-hdv5cspnk7fai6vg" }],
      domains: [{ hostname: "api.fidyapp.com" }],
    })
  ).not.toThrow();
  expect(() =>
    requireAbsentInstallation({ ...empty, scripts: [{ id: installationNames.Core }] })
  ).toThrow();
  expect(() =>
    requireAbsentInstallation({ ...empty, namespaces: [{ script: installationNames.Core }] })
  ).toThrow();
  expect(() =>
    requireAbsentInstallation({
      ...empty,
      domains: [{ hostname: "storage-acceptance.fidyapp.com" }],
    })
  ).toThrow();
  const resources = ["Core", "Ingress"].map((logicalId) => ({
    logicalId,
    resourceType: "Cloudflare.Worker",
    action: "create",
  }));
  expect(() => requireFreshPlan({ resources, actions: [] })).not.toThrow();
  for (const action of ["adopted", "update", "noop", "replace", "delete"]) {
    expect(() =>
      requireFreshPlan({ resources: [resources[0], { ...resources[1], action }], actions: [] })
    ).toThrow();
  }
});

it("binds each planned Worker to the closed installation before any provider apply", () => {
  const base = { name: installationNames.Core, workersDev: false, version: { traffic: 0 } };
  expect(() => requireInstallationWorker("Core", base)).not.toThrow();
  const ingress = {
    ...base,
    name: installationNames.Ingress,
    domain: "storage-acceptance.fidyapp.com",
  };
  expect(() => requireInstallationWorker("Ingress", ingress)).not.toThrow();
  for (const drift of [
    { name: "incumbent" },
    { domain: "api.fidyapp.com" },
    { workersDev: true },
    { version: { traffic: 100 } },
    { routes: ["api.fidyapp.com/*"] },
  ]) {
    expect(() => requireInstallationWorker("Ingress", { ...ingress, ...drift })).toThrow();
  }
  expect(() => requireInstallationWorker("Core", { ...base, domain: "api.fidyapp.com" })).toThrow();
});
