import uploadedPair from "./native-pairing-upload.json" with { type: "json" };
import { Effect } from "effect";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import type { Deployment } from "./release-controller";
import {
  type FallbackRepairPort,
  type FallbackStage,
  archivedDormant,
  recoverFixtureFallback,
  requireDormantReplacementSource,
  requirePromotedDormantSource,
  stageUploadedPair,
  verifyUnpromotedFallback,
} from "./native-fallback-recovery";

const uuid = (index: number): string =>
  String(index).padStart(8, "0") + "-1111-4111-8111-111111111111";
const revision = "a".repeat(40);
const stableRevision = "b".repeat(40);
const core = "fidy-native-storage-core";
const ingress = "fidy-native-storage-ingress";
const stage: FallbackStage = {
  revision,
  stableRevision,
  controlsDigest: "c".repeat(64),
  namespaces: {
    user: "1".repeat(32),
    directory: "2".repeat(32),
    pricing: "3".repeat(32),
    maintenance: "4".repeat(32),
    erasure: "5".repeat(32),
  },
  smoke: { deploymentId: uuid(13), versionId: uuid(14) },
  provider: { revision: stableRevision, deploymentId: uuid(11), versionId: uuid(12) },
  release: {
    snapshot: {
      revision,
      stableRevision,
      stableContractDigest: "d".repeat(64),
      core: { name: core, deploymentId: uuid(1), stableVersionId: uuid(2) },
      public: { name: ingress, deploymentId: uuid(3), stableVersionId: uuid(4) },
    },
    coreDeploymentId: uuid(5),
    publicDeploymentId: uuid(6),
    coreVersionId: uuid(7),
    publicVersionId: uuid(8),
  },
};
const harness = (): {
  port: FallbackRepairPort;
  deployments: (name: string) => Deployment[];
  writes: string[];
} => {
  const history = new Map<string, Deployment[]>([
    [
      core,
      [
        {
          id: uuid(5),
          versions: [
            { id: uuid(2), percentage: 100 },
            { id: uuid(7), percentage: 0 },
          ],
        },
      ],
    ],
    [
      ingress,
      [
        {
          id: uuid(6),
          versions: [
            { id: uuid(8), percentage: 0 },
            { id: uuid(4), percentage: 100 },
          ],
        },
      ],
    ],
  ]);
  const deployments = (name: string): Deployment[] => {
    const rows = history.get(name);
    if (rows === undefined) throw Error("Unknown Worker");
    return rows;
  };
  const writes: string[] = [];
  const port: FallbackRepairPort = {
    trunk: () => Effect.succeed(revision),
    current: (name) =>
      Effect.gen(function* () {
        const [current] = deployments(name);
        if (current === undefined) return yield* Effect.fail(Error("Missing Worker deployment"));
        return structuredClone(current);
      }),
    recentDeployments: (name) => Effect.sync(() => structuredClone(deployments(name))),
    deploy: (name, versions) =>
      Effect.sync(() => {
        const result = { id: name === core ? uuid(9) : uuid(10), versions };
        deployments(name).unshift(result);
        writes.push(name);
        return result;
      }),
  };
  return { port, deployments, writes };
};
const verify = (): Effect.Effect<void, Error> => Effect.void;

it.effect("finishes the exact staged dormant pair and verifies a repeat without redeploying", () =>
  Effect.gen(function* () {
    const { port, writes } = harness();
    const phases: string[] = [];
    const check = (_stage: FallbackStage, phase: "before" | "after"): Effect.Effect<void> =>
      Effect.sync(() => {
        phases.push(phase);
      });
    const expected = { coreDeploymentId: uuid(9), publicDeploymentId: uuid(10) };
    expect(yield* recoverFixtureFallback(port, stage, check)).toEqual(expected);
    expect(yield* recoverFixtureFallback(port, stage, check)).toEqual(expected);
    expect(writes).toEqual([core, ingress]);
    expect(phases).toEqual(["before", "after", "before", "after"]);
  })
);

it.effect("after an interrupted Core promotion advances only the staged Ingress", () =>
  Effect.gen(function* () {
    const { port, writes, deployments } = harness();
    deployments(core).unshift({ id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] });
    yield* recoverFixtureFallback(port, stage, verify);
    expect(writes).toEqual([ingress]);
  })
);

it.effect(
  "refuses an intervening deployment even if the expected Core version is serving again",
  () =>
    Effect.gen(function* () {
      const { port, writes, deployments } = harness();
      deployments(core).unshift(
        { id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] },
        { id: uuid(20), versions: [{ id: uuid(21), percentage: 100 }] }
      );
      expect((yield* Effect.flip(recoverFixtureFallback(port, stage, verify))).message).toContain(
        "archived dormant stage"
      );
      expect(writes).toEqual([]);
    })
);

it.effect("refuses an Ingress-first state and a closed verification failure before any write", () =>
  Effect.gen(function* () {
    const { port, writes, deployments } = harness();
    const denied = (): Effect.Effect<void, Error> => Effect.fail(Error("unqualified"));
    expect((yield* Effect.flip(recoverFixtureFallback(port, stage, denied))).message).toBe(
      "unqualified"
    );
    deployments(ingress).unshift({ id: uuid(10), versions: [{ id: uuid(8), percentage: 100 }] });
    expect((yield* Effect.flip(recoverFixtureFallback(port, stage, verify))).message).toContain(
      "before its Core"
    );
    expect(writes).toEqual([]);
  })
);

it.effect(
  "refuses superseded revisions, foreign Workers and namespace aliases before promotion",
  () =>
    Effect.gen(function* () {
      const { port, writes } = harness();
      const stale: FallbackRepairPort = { ...port, trunk: () => Effect.succeed("f".repeat(40)) };
      expect((yield* Effect.flip(recoverFixtureFallback(stale, stage, verify))).message).toContain(
        "superseded"
      );
      const other = { ...stage.release.snapshot.core, name: "another-core" };
      const foreign = {
        ...stage,
        release: { ...stage.release, snapshot: { ...stage.release.snapshot, core: other } },
      };
      const alias = {
        ...stage,
        namespaces: { ...stage.namespaces, user: stage.namespaces.directory },
      };
      for (const invalid of [foreign, alias]) {
        expect(
          (yield* Effect.flip(recoverFixtureFallback(port, invalid, verify))).message
        ).toContain("Inconsistent");
      }
      expect(writes).toEqual([]);
    })
);

it.effect("requires the same deployment IDs after the closed preflight", () =>
  Effect.gen(function* () {
    const { port, writes, deployments } = harness();
    const raced = (): Effect.Effect<void> =>
      Effect.sync(() => {
        deployments(core).unshift({ id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] });
      });
    expect((yield* Effect.flip(recoverFixtureFallback(port, stage, raced))).message).toContain(
      "changed during verification"
    );
    expect(writes).toEqual([]);
  })
);

it.effect("reseals only the same zero-traffic pair on its exact original deployment history", () =>
  Effect.gen(function* () {
    const { port, deployments, writes } = harness();
    for (const role of ["core", "public"] as const) {
      const capture = stage.release.snapshot[role];
      deployments(capture.name).push({
        id: capture.deploymentId,
        versions: [{ id: capture.stableVersionId, percentage: 100 }],
      });
    }
    let checks = 0;
    const verify = Effect.sync(() => ++checks);
    expect(yield* verifyUnpromotedFallback({ port, release: stage.release, verify })).toBe(1);
    const original = deployments(ingress)[1];
    if (original === undefined) throw Error("Missing original test deployment");
    deployments(ingress)[1] = { ...original, id: uuid(199) };
    expect(
      yield* verifyUnpromotedFallback({ port, release: stage.release, verify }).pipe(
        Effect.isFailure
      )
    ).toBe(true);
    expect(checks).toBe(1);
    deployments(ingress)[1] = original;
    const swap = Effect.sync(() => {
      deployments(core)[0] = {
        id: uuid(200),
        versions: [{ id: stage.release.coreVersionId, percentage: 100 }],
      };
    });
    expect(
      yield* verifyUnpromotedFallback({ port, release: stage.release, verify: swap }).pipe(
        Effect.isFailure
      )
    ).toBe(true);
    expect(
      yield* verifyUnpromotedFallback({ port, release: stage.release, verify }).pipe(
        Effect.isFailure
      )
    ).toBe(true);
    expect(checks).toBe(1);
    expect(writes).toEqual([]);
  })
);

it.effect("replaces only the archived zero-traffic pair over the captured stable release", () =>
  Effect.gen(function* () {
    const { port, deployments, writes } = harness();
    const snapshot = { ...stage.release.snapshot };
    for (const role of ["core", "public"] as const) {
      const capture = snapshot[role];
      snapshot[role] = {
        ...capture,
        deploymentId: archivedDormant[`${role}DeploymentId`],
        stableVersionId: archivedDormant.original[role],
      };
      deployments(capture.name)[0] = {
        id: snapshot[role].deploymentId,
        versions: [
          { id: archivedDormant[`${role}VersionId`], percentage: 0 },
          { id: snapshot[role].stableVersionId, percentage: 100 },
        ],
      };
    }
    yield* requireDormantReplacementSource(port, snapshot);
    const active = deployments(core)[0];
    if (active === undefined) throw Error("Missing staged Core");
    deployments(core)[0] = {
      ...active,
      versions: [{ id: archivedDormant.coreVersionId, percentage: 100 }],
    };
    expect(yield* Effect.isFailure(requireDormantReplacementSource(port, snapshot))).toBe(true);
    expect(writes).toEqual([]);
  })
);

it.effect(
  "admits the active receipt only above the promoted, sealed replacement in both Worker histories",
  () =>
    Effect.gen(function* () {
      const { port, deployments } = harness();
      const promoted = yield* recoverFixtureFallback(port, stage, verify);
      const snapshot = {
        ...stage.release.snapshot,
        stableRevision: stage.revision,
        core: {
          name: core,
          deploymentId: promoted.coreDeploymentId,
          stableVersionId: stage.release.coreVersionId,
        },
        public: {
          name: ingress,
          deploymentId: promoted.publicDeploymentId,
          stableVersionId: stage.release.publicVersionId,
        },
      };
      yield* requirePromotedDormantSource(port, snapshot, stage.release);
      deployments(core).splice(1, 1, {
        id: uuid(35),
        versions: [{ id: stage.release.coreVersionId, percentage: 100 }],
      });
      expect(
        yield* requirePromotedDormantSource(port, snapshot, stage.release).pipe(Effect.isFailure)
      ).toBe(true);
    })
);

it.effect(
  "reuses the uploaded versions over the exact 100/0 predecessor and resumes only missing zero-traffic assignments",
  () =>
    Effect.gen(function* () {
      const { port: base, deployments, writes } = harness();
      const port: FallbackRepairPort = {
        ...base,
        trunk: () => Effect.succeed(uploadedPair.revision),
      };
      const snapshot = { ...stage.release.snapshot, revision: uploadedPair.revision };
      for (const role of ["core", "public"] as const) {
        snapshot[role] = {
          ...snapshot[role],
          deploymentId: archivedDormant[`${role}DeploymentId`],
          stableVersionId: archivedDormant.original[role],
        };
        deployments(snapshot[role].name).splice(0, 1, {
          id: snapshot[role].deploymentId,
          versions: [
            { id: archivedDormant.original[role], percentage: 100 },
            { id: archivedDormant[`${role}VersionId`], percentage: 0 },
          ],
        });
      }
      expect(
        yield* stageUploadedPair(port, snapshot, Effect.fail(Error("missing receipt"))).pipe(
          Effect.isFailure
        )
      ).toBe(true);
      expect(writes).toEqual([]);
      const staged = yield* stageUploadedPair(port, snapshot, Effect.void);
      expect(staged).toMatchObject({
        coreVersionId: uploadedPair.coreVersionId,
        publicVersionId: uploadedPair.publicVersionId,
      });
      expect(writes).toEqual([ingress, core]);
      expect(yield* stageUploadedPair(port, snapshot, Effect.void)).toEqual(staged);
      expect(writes).toEqual([ingress, core]);
      deployments(core).shift();
      expect(yield* stageUploadedPair(port, snapshot, Effect.void)).toEqual(staged);
      expect(writes).toEqual([ingress, core, core]);
      deployments(ingress)[0] = {
        id: staged.publicDeploymentId,
        versions: [{ id: uploadedPair.publicVersionId, percentage: 100 }],
      };
      expect(yield* stageUploadedPair(port, snapshot, Effect.void).pipe(Effect.isFailure)).toBe(
        true
      );
      expect(writes).toEqual([ingress, core, core]);
    })
);
