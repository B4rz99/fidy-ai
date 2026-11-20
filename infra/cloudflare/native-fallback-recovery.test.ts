import { Effect } from "effect";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import type { Deployment } from "./release-controller";
import {
  type FallbackRepairPort,
  type FallbackStage,
  recoverFixtureFallback,
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
