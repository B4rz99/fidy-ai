import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type Deployment, type StagedRelease } from "./release-controller";
import { type RollbackPort, releaseRollback } from "./release-rollback";

const stablePublic = "11111111-1111-4111-8111-111111111111";
const stableCore = "22222222-2222-4222-8222-222222222222";
const candidatePublic = "33333333-3333-4333-8333-333333333333";
const candidateCore = "44444444-4444-4444-8444-444444444444";
const publicName = "fidy-ingress";
const coreName = "fidy-core";
const release: StagedRelease = {
  snapshot: {
    revision: "a".repeat(40),
    stableRevision: "b".repeat(40),
    stableContractDigest: "c".repeat(64),
    public: {
      name: publicName,
      deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      stableVersionId: stablePublic,
    },
    core: {
      name: coreName,
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      stableVersionId: stableCore,
    },
  },
  publicVersionId: candidatePublic,
  coreVersionId: candidateCore,
  publicDeploymentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  coreDeploymentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const promoted = {
  publicDeploymentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  coreDeploymentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
type Fixture = Readonly<{
  port: RollbackPort;
  writes: string[];
  deployments: Map<string, Deployment>;
  block(name: string): void;
  unavailable(): void;
  raceCoreAfterPublic(): void;
}>;
const fixture = (): Fixture => {
  const deployments = new Map<string, Deployment>([
    [
      publicName,
      { id: promoted.publicDeploymentId, versions: [{ id: candidatePublic, percentage: 100 }] },
    ],
    [
      coreName,
      { id: promoted.coreDeploymentId, versions: [{ id: candidateCore, percentage: 100 }] },
    ],
  ]);
  const writes: string[] = [];
  let blocked = Option.none<string>();
  let available = true;
  let raceCore = false;
  const port: RollbackPort = {
    trunk: (): Effect.Effect<string, Error> => Effect.succeed(release.snapshot.revision),
    current: (name: string): Effect.Effect<Deployment, Error> =>
      Effect.gen(function* () {
        const observed = deployments.get(name);
        if (observed === undefined) return yield* Effect.fail(Error("missing Worker"));
        return structuredClone(observed);
      }),
    deploy: (name: string, versions: Deployment["versions"]): Effect.Effect<Deployment, Error> =>
      Effect.gen(function* () {
        writes.push(name);
        if (Option.contains(blocked, name)) return yield* Effect.fail(Error("provider rejected"));
        const next = {
          id: `${String(writes.length).padStart(8, "0")}-9999-4999-8999-999999999999`,
          versions: [...versions],
        };
        deployments.set(name, next);
        if (name === publicName && raceCore) {
          deployments.set(coreName, {
            id: "99999999-9999-4999-8999-999999999999",
            versions: [{ id: candidateCore, percentage: 100 }],
          });
        }
        return next;
      }),
    deployable: (_name: string, _version: string): Effect.Effect<boolean, Error> =>
      Effect.sync(() => available),
  };
  return {
    port,
    writes,
    deployments,
    block: (name: string): void => {
      blocked = Option.some(name);
    },
    unavailable: (): void => {
      available = false;
    },
    raceCoreAfterPublic: (): void => {
      raceCore = true;
    },
  };
};

describe("post-promotion code rollback", () => {
  it("returns public traffic first, then Core, to the captured stable versions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = fixture();
        yield* releaseRollback.restore(setup.port, { release, promoted, compatible: true });
        expect(setup.writes).toEqual([publicName, coreName]);
        expect((yield* setup.port.current(publicName)).versions).toEqual([
          { id: stablePublic, percentage: 100 },
        ]);
        expect((yield* setup.port.current(coreName)).versions).toEqual([
          { id: stableCore, percentage: 100 },
        ]);
      })
    ));

  it("refuses incompatible or unavailable stable versions without changing traffic", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = fixture();
        const incompatible = yield* Effect.exit(
          releaseRollback.restore(setup.port, { release, promoted, compatible: false })
        );
        setup.unavailable();
        const unavailable = yield* Effect.exit(
          releaseRollback.restore(setup.port, { release, promoted, compatible: true })
        );
        expect(incompatible._tag).toBe("Failure");
        expect(unavailable._tag).toBe("Failure");
        expect(setup.writes).toEqual([]);
      })
    ));

  it("refuses changed traffic instead of overwriting another deployment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = fixture();
        setup.deployments.set(publicName, {
          id: "99999999-9999-4999-8999-999999999999",
          versions: [{ id: candidatePublic, percentage: 100 }],
        });
        const outcome = yield* Effect.exit(
          releaseRollback.restore(setup.port, { release, promoted, compatible: true })
        );
        expect(outcome._tag).toBe("Failure");
        expect(setup.writes).toEqual([]);
      })
    ));

  it("refuses to overwrite Core when another deployment takes over after public restoration", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = fixture();
        setup.raceCoreAfterPublic();
        const outcome = yield* Effect.exit(
          releaseRollback.restore(setup.port, { release, promoted, compatible: true })
        );
        expect(outcome._tag).toBe("Failure");
        expect(setup.writes).toEqual([publicName]);
      })
    ));

  it("stops with visible split traffic if Core restoration fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = fixture();
        setup.block(coreName);
        const outcome = yield* Effect.exit(
          releaseRollback.restore(setup.port, { release, promoted, compatible: true })
        );
        expect(outcome._tag).toBe("Failure");
        expect((yield* setup.port.current(publicName)).versions).toEqual([
          { id: stablePublic, percentage: 100 },
        ]);
        expect((yield* setup.port.current(coreName)).versions).toEqual([
          { id: candidateCore, percentage: 100 },
        ]);
      })
    ));
});
