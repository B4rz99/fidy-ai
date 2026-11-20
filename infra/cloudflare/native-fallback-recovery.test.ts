import { Effect } from "effect";
import { expect, it } from "vitest";
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

it("finishes the exact staged dormant pair and verifies a repeated recovery without redeploying", async () => {
  const { port, writes } = harness();
  const phases: string[] = [];
  const check = (_stage: FallbackStage, phase: "before" | "after"): Effect.Effect<void> =>
    Effect.sync(() => {
      phases.push(phase);
    });
  const expected = { coreDeploymentId: uuid(9), publicDeploymentId: uuid(10) };
  await expect(Effect.runPromise(recoverFixtureFallback(port, stage, check))).resolves.toEqual(
    expected
  );
  await expect(Effect.runPromise(recoverFixtureFallback(port, stage, check))).resolves.toEqual(
    expected
  );
  expect(writes).toEqual([core, ingress]);
  expect(phases).toEqual(["before", "after", "before", "after"]);
});

it("after an interrupted Core promotion advances only the staged Ingress", async () => {
  const { port, writes, deployments } = harness();
  deployments(core).unshift({ id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] });
  await Effect.runPromise(recoverFixtureFallback(port, stage, verify));
  expect(writes).toEqual([ingress]);
});

it("refuses an intervening deployment even if the expected Core version is serving again", async () => {
  const { port, writes, deployments } = harness();
  deployments(core).unshift(
    { id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] },
    { id: uuid(20), versions: [{ id: uuid(21), percentage: 100 }] }
  );
  await expect(Effect.runPromise(recoverFixtureFallback(port, stage, verify))).rejects.toThrow();
  expect(writes).toEqual([]);
});

it("refuses an Ingress-first state and a closed verification failure before any write", async () => {
  const { port, writes, deployments } = harness();
  await expect(
    Effect.runPromise(recoverFixtureFallback(port, stage, () => Effect.fail(Error("unqualified"))))
  ).rejects.toThrow("unqualified");
  deployments(ingress).unshift({ id: uuid(10), versions: [{ id: uuid(8), percentage: 100 }] });
  await expect(Effect.runPromise(recoverFixtureFallback(port, stage, verify))).rejects.toThrow();
  expect(writes).toEqual([]);
});

it("refuses a superseded revision, foreign Worker or namespace alias before promotion", async () => {
  const { port, writes } = harness();
  await expect(
    Effect.runPromise(
      recoverFixtureFallback(
        { ...port, trunk: () => Effect.succeed("f".repeat(40)) },
        stage,
        verify
      )
    )
  ).rejects.toThrow();
  const other = { ...stage.release.snapshot.core, name: "another-core" };
  const foreign = {
    ...stage,
    release: { ...stage.release, snapshot: { ...stage.release.snapshot, core: other } },
  };
  await expect(Effect.runPromise(recoverFixtureFallback(port, foreign, verify))).rejects.toThrow();
  const alias = { ...stage, namespaces: { ...stage.namespaces, user: stage.namespaces.directory } };
  await expect(Effect.runPromise(recoverFixtureFallback(port, alias, verify))).rejects.toThrow();
  expect(writes).toEqual([]);
});

it("requires the same deployment IDs after the closed preflight", async () => {
  const { port, writes, deployments } = harness();
  const raced = (): Effect.Effect<void> =>
    Effect.sync(() => {
      deployments(core).unshift({ id: uuid(9), versions: [{ id: uuid(7), percentage: 100 }] });
    });
  await expect(Effect.runPromise(recoverFixtureFallback(port, stage, raced))).rejects.toThrow(
    "changed during verification"
  );
  expect(writes).toEqual([]);
});
