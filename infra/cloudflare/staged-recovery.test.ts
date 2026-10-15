import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { type Deployment } from "./release-controller";
import { type RecoveryPort, recoverStaged } from "./staged-recovery";

const revision = "a".repeat(40);
const publicStable = "11111111-1111-4111-8111-111111111111";
const coreStable = "22222222-2222-4222-8222-222222222222";
const publicCandidate = "33333333-3333-4333-8333-333333333333";
const coreCandidate = "44444444-4444-4444-8444-444444444444";
const request = {
  revision,
  public: {
    name: "fidy-ingress",
    deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    candidateVersionId: publicCandidate,
  },
  core: {
    name: "fidy-core",
    deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    candidateVersionId: coreCandidate,
  },
};
type Harness = Readonly<{
  port: RecoveryPort;
  deployments: Map<string, Deployment>;
  writes: Array<{ name: string; versions: Deployment["versions"] }>;
  proofs: Array<{ publicVersionId: string; coreVersionId: string }>;
}>;
const getDeployment = (deployments: ReadonlyMap<string, Deployment>, name: string): Deployment => {
  const deployment = deployments.get(name);
  if (deployment === undefined) throw Error("Missing fixture deployment");
  return deployment;
};
const harness = (): Harness => {
  const deployments = new Map<string, Deployment>([
    [
      request.public.name,
      {
        id: request.public.deploymentId,
        versions: [
          { id: publicStable, percentage: 100 },
          { id: publicCandidate, percentage: 0 },
        ],
      },
    ],
    [
      request.core.name,
      {
        id: request.core.deploymentId,
        versions: [
          { id: coreStable, percentage: 100 },
          { id: coreCandidate, percentage: 0 },
        ],
      },
    ],
  ]);
  const writes: Array<{ name: string; versions: Deployment["versions"] }> = [];
  const proofs: Array<{ publicVersionId: string; coreVersionId: string }> = [];
  const port: RecoveryPort = {
    trunk: () => Effect.succeed(revision),
    current: (name) => Effect.sync(() => structuredClone(getDeployment(deployments, name))),
    deploy: (name, versions) =>
      Effect.sync(() => {
        const result = {
          id: `0000000${writes.length + 1}-cccc-4ccc-8ccc-cccccccccccc`,
          versions: [...versions],
        };
        writes.push({ name, versions });
        deployments.set(name, result);
        return result;
      }),
    verifyPair: (pair) =>
      Effect.sync(() => {
        proofs.push(pair);
      }),
  };
  return { port, deployments, writes, proofs };
};
it.effect(
  "removes only the inspected zero-traffic candidates and proves the same serving pair before and after",
  () =>
    Effect.gen(function* () {
      const fixture = harness();
      yield* recoverStaged(fixture.port, request);
      expect(fixture.writes).toEqual([
        { name: request.public.name, versions: [{ id: publicStable, percentage: 100 }] },
        { name: request.core.name, versions: [{ id: coreStable, percentage: 100 }] },
      ]);
      expect(fixture.proofs).toEqual([
        { publicVersionId: publicStable, coreVersionId: coreStable },
        { publicVersionId: publicStable, coreVersionId: coreStable },
      ]);
    })
);

it.effect.each([
  {
    label: "candidate receiving traffic",
    change: (deployment: Deployment): Deployment => ({
      ...deployment,
      versions: [
        { id: coreStable, percentage: 90 },
        { id: coreCandidate, percentage: 10 },
      ],
    }),
  },
  {
    label: "uninspected deployment",
    change: (deployment: Deployment): Deployment => ({
      ...deployment,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }),
  },
  {
    label: "different candidate",
    change: (deployment: Deployment): Deployment => ({
      ...deployment,
      versions: [
        { id: coreStable, percentage: 100 },
        { id: publicCandidate, percentage: 0 },
      ],
    }),
  },
  {
    label: "already promoted candidate",
    change: (deployment: Deployment): Deployment => ({
      ...deployment,
      versions: [{ id: coreCandidate, percentage: 100 }],
    }),
  },
])("refuses $label before changing either Worker", ({ change }) =>
  Effect.gen(function* () {
    const fixture = harness();
    fixture.deployments.set(
      request.core.name,
      change(yield* fixture.port.current(request.core.name))
    );
    const result = yield* Effect.exit(recoverStaged(fixture.port, request));
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([]);
  })
);

it.effect("refuses an unverifiable serving pair without a traffic write", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const result = yield* Effect.exit(
      recoverStaged(
        { ...fixture.port, verifyPair: () => Effect.fail(Error("pair mismatch")) },
        request
      )
    );
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([]);
  })
);
it.effect("rechecks both deployment IDs after the proof before any traffic write", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const result = yield* Effect.exit(
      recoverStaged(
        {
          ...fixture.port,
          verifyPair: () =>
            Effect.sync(() => {
              const current = getDeployment(fixture.deployments, request.core.name);
              fixture.deployments.set(request.core.name, {
                ...current,
                id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              });
            }),
        },
        request
      )
    );
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([]);
  })
);
it.effect("refuses superseded trunk without a traffic write", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const result = yield* Effect.exit(
      recoverStaged({ ...fixture.port, trunk: () => Effect.succeed("b".repeat(40)) }, request)
    );
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([]);
  })
);
it.effect("stops before Core cleanup if routing changes after public cleanup", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const result = yield* Effect.exit(
      recoverStaged(
        {
          ...fixture.port,
          deploy: (name, versions) =>
            fixture.port.deploy(name, versions).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (name === request.public.name) {
                    const current = getDeployment(fixture.deployments, request.core.name);
                    fixture.deployments.set(request.core.name, {
                      ...current,
                      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    });
                  }
                })
              )
            ),
        },
        request
      )
    );
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([
      { name: request.public.name, versions: [{ id: publicStable, percentage: 100 }] },
    ]);
  })
);
it.effect("refuses using one Worker for both roles", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const result = yield* Effect.exit(
      recoverStaged(fixture.port, {
        ...request,
        core: { ...request.core, name: request.public.name },
      })
    );
    expect(result._tag).toBe("Failure");
    expect(fixture.writes).toEqual([]);
  })
);
