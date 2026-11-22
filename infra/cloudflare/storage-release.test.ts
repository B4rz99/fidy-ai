import {
  nativeBindingInventory,
  nativeResourceInventory,
  requireNativeResourcePlan,
} from "./native-graph";
import {
  installationNames,
  requireAbsentInstallation,
  requireClosedBindings,
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

it.effect("recognizes only the reviewed comment-only protocol pair", () =>
  Effect.gen(function* () {
    const storage = yield* buildStorageRelease();
    const predecessor = "87d29c622bb96d493a602d18741fa4b8532871914bc956c0560d909e4377c4f5";
    const reformatted = "176dcf18c895cce04e5abe6dde4cc541c46bdd189b4ecfc85fec8621c672b3e3";

    const describeProtocol = (write: string): typeof storage => ({
      ...storage,
      protocol: { write, readers: [write] },
    });

    const stable = describeProtocol(predecessor);
    const candidate = describeProtocol(reformatted);
    expect(storageOverlap({ stable, candidate })).toEqual({ forward: true, rollback: true });
    expect(storageOverlap({ stable: candidate, candidate: stable })).toEqual({
      forward: true,
      rollback: true,
    });
    const foreign = describeProtocol(reformatted.slice(0, -1) + "4");
    expect(storageOverlap({ stable, candidate: foreign }).forward).toBe(false);

    const newWriter = {
      ...foreign,
      protocol: { ...foreign.protocol, readers: [reformatted] },
    };

    expect(storageOverlap({ stable, candidate: newWriter }).forward).toBe(false);

    const rewritten = {
      ...candidate,
      histories: { ...candidate.histories, pricing: ["e".repeat(64)] },
    };

    expect(storageOverlap({ stable, candidate: rewritten }).forward).toBe(false);
  })
);

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
      verifiedStoragePair({ ingress: { ...ingress, PRICING: bindings.PRICING ?? null }, core })
    ).toThrow();
    expect(() =>
      verifiedStoragePair({ ingress, core: { ...core, ERASURE: bindings.MAINTENANCE ?? null } })
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
  const revision = "1".repeat(40);

  const resources = [...nativeResourceInventory(revision)].map(([logicalId, resourceType]) => ({
    logicalId,
    resourceType,
    action: "create",
  }));

  const plan = (rows: typeof resources, first: boolean): void =>
    requireNativeResourcePlan({ plan: { resources: rows, actions: [] }, revision, first });

  expect(resources.length).toBeGreaterThan(40);
  expect(() => plan(resources, true)).not.toThrow();
  expect(() =>
    plan(
      resources.filter((row) => row.resourceType === "Cloudflare.Worker"),
      true
    )
  ).toThrow();

  for (const action of ["adopted", "update", "noop", "replace", "delete"]) {
    expect(() =>
      plan(
        resources.map((row, index) => (index === 0 ? { ...row, action } : row)),
        true
      )
    ).toThrow();
  }

  expect(() =>
    plan(
      resources.map((row) => ({ ...row, action: "noop" })),
      false
    )
  ).not.toThrow();
});

it("binds each planned Worker to the closed installation before any provider apply", () => {
  const revision = "1".repeat(40);
  const base = { name: installationNames.Core, workersDev: false, version: { traffic: 0 } };
  expect(() =>
    requireInstallationWorker({
      hosts: "acceptance",
      logicalId: "Core",
      revision,
      props: { ...base, crons: ["* * * * *"] },
    })
  ).not.toThrow();

  const ingress = {
    ...base,
    name: installationNames.Ingress,
    domain: { name: "storage-acceptance.fidyapp.com", aliases: [] },
  };

  expect(() =>
    requireInstallationWorker({
      hosts: "acceptance",
      logicalId: "Ingress",
      revision,
      props: ingress,
    })
  ).not.toThrow();

  for (const drift of [
    { name: "incumbent" },
    { domain: "api.fidyapp.com" },
    { workersDev: true },
    { version: { traffic: 100 } },
    { routes: ["api.fidyapp.com/*"] },
    { crons: ["* * * * *"] },
    { tailConsumers: ["another-worker"] },
  ]) {
    expect(() =>
      requireInstallationWorker({
        hosts: "acceptance",
        logicalId: "Ingress",
        revision,
        props: { ...ingress, ...drift },
      })
    ).toThrow();
  }

  expect(() =>
    requireInstallationWorker({
      hosts: "acceptance",
      logicalId: "Core",
      revision,
      props: { ...base, domain: "api.fidyapp.com" },
    })
  ).toThrow();
});

it("rejects open admission and producer bindings before applying either Worker", () => {
  const closed = { name: "RECOVERY_ISOLATION", type: "plain_text", text: "isolated" };
  const core = { name: "CORE", type: "service" };

  const complete = [...nativeBindingInventory({ fingerprint: "", role: "Ingress" })].map(
    ([name, type]) => ({
      name,
      type,
      text:
        new Map([
          ["RECOVERY_ISOLATION", "isolated"],
          ["NATIVE_STORAGE_ADMISSION", "closed"],
        ]).get(name) ?? "",
    })
  );

  expect(() =>
    requireClosedBindings({ fingerprint: "", worker: "Ingress", bindings: complete })
  ).not.toThrow();
  expect(() =>
    requireClosedBindings({ fingerprint: "", worker: "Ingress", bindings: [closed, core] })
  ).toThrow();
  expect(() =>
    requireClosedBindings({
      fingerprint: "",
      worker: "Ingress",
      bindings: [...complete.slice(1), core],
    })
  ).toThrow();
  expect(() =>
    requireClosedBindings({ fingerprint: "", worker: "Core", bindings: complete })
  ).toThrow();

  for (const worker of ["Ingress", "Core"] as const) {
    expect(() => requireClosedBindings({ fingerprint: "", worker, bindings: [] })).toThrow();
    expect(() =>
      requireClosedBindings({ fingerprint: "", worker, bindings: [{ ...closed, text: "" }] })
    ).toThrow();

    for (const type of ["queue", "workflow", "send_email", "d1"]) {
      expect(() =>
        requireClosedBindings({
          fingerprint: "",
          worker,
          bindings: [closed, { name: "EXTRA", type }],
        })
      ).toThrow();
    }
  }
});
