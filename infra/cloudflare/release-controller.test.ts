import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  type StagedRelease,
  releaseController,
} from "./release-controller";
import { releaseCleanup } from "./release-cleanup";

const publicName = "fidy-ingress";
const coreName = "fidy-core";
const versions = {
  publicStable: "11111111-1111-4111-8111-111111111111",
  coreStable: "22222222-2222-4222-8222-222222222222",
  publicCandidate: "33333333-3333-4333-8333-333333333333",
  coreCandidate: "44444444-4444-4444-8444-444444444444",
};
const revision = "a".repeat(40);
type Harness = Readonly<{
  port: ReleasePort;
  changes: string[];
  supersede: () => void;
  fail: (step: string) => void;
}>;
const harness = (): Harness => {
  const deployments = new Map<string, Deployment>([
    [
      publicName,
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versions: [{ id: versions.publicStable, percentage: 100 }],
      },
    ],
    [
      coreName,
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        versions: [{ id: versions.coreStable, percentage: 100 }],
      },
    ],
  ]);
  const changes: string[] = [];
  let trunk = revision;
  let failOn = Option.none<string>();
  const port: ReleasePort = {
    trunk: () => Effect.sync(() => trunk),
    current: (name) =>
      Effect.gen(function* () {
        const deployment = deployments.get(name);
        if (deployment === undefined) return yield* Effect.fail(Error("missing deployment"));
        return structuredClone(deployment);
      }),
    deploy: (name, entries) =>
      Effect.gen(function* () {
        const step = `${name}:${entries.map((version) => version.percentage).join("/")}`;
        changes.push(step);
        if (Option.contains(failOn, step)) return yield* Effect.fail(Error("provider refused"));
        const result: Deployment = {
          id: `${String(changes.length).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`,
          versions: [...entries],
        };
        deployments.set(name, result);
        return result;
      }),
  };
  return {
    port,
    changes,
    supersede: (): void => {
      trunk = "b".repeat(40);
    },
    fail: (step: string): void => {
      failOn = Option.some(step);
    },
  };
};
const candidates = {
  publicVersionId: versions.publicCandidate,
  coreVersionId: versions.coreCandidate,
};
const captured = (port: ReleasePort): Effect.Effect<ReleaseSnapshot, Error> =>
  releaseController.captureRelease(port, {
    revision,
    stableRevision: "b".repeat(40),
    stableContractDigest: "c".repeat(64),
    publicName,
    coreName,
  });

it.effect("permits resource retirement only while the promoted pair still owns exact traffic", () =>
  Effect.gen(function* () {
    const fixture = harness();
    const snapshot = yield* captured(fixture.port);
    const release = yield* releaseController.stageRelease(fixture.port, snapshot, candidates);
    const promoted = yield* releaseController.promoteRelease(fixture.port, release, {
      exactPairPassed: true,
      middlePairPassed: true,
    });
    const beforeVerification = [...fixture.changes];
    yield* releaseController.verifyRetirement(fixture.port, { release, promoted });
    expect(fixture.changes).toEqual(beforeVerification);
    yield* fixture.port.deploy(coreName, [{ id: versions.coreStable, percentage: 100 }]);
    const changed = yield* Effect.exit(
      releaseController.verifyRetirement(fixture.port, { release, promoted })
    );
    expect(Exit.isFailure(changed)).toBe(true);
  })
);

it.effect("refuses retirement for superseded, unreadable, or replaced deployment receipts", () =>
  Effect.gen(function* () {
    for (const scenario of ["superseded", publicName, coreName, "new-receipt"]) {
      const fixture = harness();
      const snapshot = yield* captured(fixture.port);
      const release = yield* releaseController.stageRelease(fixture.port, snapshot, candidates);
      const promoted = yield* releaseController.promoteRelease(fixture.port, release, {
        exactPairPassed: true,
        middlePairPassed: true,
      });
      if (scenario === "superseded") {
        fixture.supersede();
      }
      if (scenario === "new-receipt") {
        yield* fixture.port.deploy(publicName, [{ id: versions.publicCandidate, percentage: 100 }]);
      }
      const beforeVerification = [...fixture.changes];
      const port: ReleasePort = {
        ...fixture.port,
        current: (name) =>
          scenario === name
            ? Effect.fail(Error("unreadable deployment"))
            : fixture.port.current(name),
      };
      expect(
        Exit.isFailure(
          yield* Effect.exit(releaseController.verifyRetirement(port, { release, promoted }))
        )
      ).toBe(true);
      expect(fixture.changes).toEqual(beforeVerification);
    }
  })
);

const isolationOrdering =
  (fixture: Harness): (() => Effect.Effect<void, Error>) =>
  () =>
    Effect.gen(function* () {
      expect(fixture.changes).toEqual([`${publicName}:100`]);
      expect((yield* fixture.port.current(publicName)).versions).toEqual([
        { id: versions.publicCandidate, percentage: 100 },
      ]);
      expect((yield* fixture.port.current(coreName)).versions).toEqual([
        { id: versions.coreStable, percentage: 100 },
      ]);
    });

describe("deleted-resource isolation", () => {
  it.effect("closes public admission and proves isolation before replacing private Core", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const snapshot = yield* captured(fixture.port);
      const result = yield* releaseController.isolateRelease(fixture.port, snapshot, {
        candidate: candidates,
        proveIsolation: isolationOrdering(fixture),
      });
      expect(fixture.changes).toEqual([`${publicName}:100`, `${coreName}:100`]);
      expect(result.coreVersionId).toBe(versions.coreCandidate);
    })
  );

  it.effect("leaves Core untouched when isolation evidence fails", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const snapshot = yield* captured(fixture.port);
      const exit = yield* releaseController
        .isolateRelease(fixture.port, snapshot, {
          candidate: candidates,
          proveIsolation: () => Effect.fail(Error("Admission is not isolated")),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(fixture.changes).toEqual([`${publicName}:100`]);
      expect((yield* fixture.port.current(coreName)).versions).toEqual([
        { id: versions.coreStable, percentage: 100 },
      ]);
    })
  );

  it.effect("refuses a superseded revision before isolation writes", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const snapshot = yield* captured(fixture.port);
      fixture.supersede();
      const exit = yield* releaseController
        .isolateRelease(fixture.port, snapshot, {
          candidate: candidates,
          proveIsolation: () => Effect.void,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(fixture.changes).toEqual([]);
    })
  );
});
const staged = (port: ReleasePort): Effect.Effect<StagedRelease, Error> =>
  Effect.gen(function* () {
    return yield* releaseController.stageRelease(port, yield* captured(port), candidates);
  });
const failure = (effect: Effect.Effect<unknown, Error>, message: string): Effect.Effect<void> =>
  effect.pipe(
    Effect.match({
      onSuccess: () => {
        throw Error(`Expected failure containing ${message}`);
      },
      onFailure: (error) => {
        expect(error.message).toContain(message);
      },
    })
  );

describe("zero-traffic Worker release", () => {
  it("captures both stable Workers with overlapping reads and no traffic writes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const bothStarted = yield* Deferred.make<void>();
        const names = new Set<string>();
        const port: ReleasePort = {
          ...fixture.port,
          current: (name) =>
            Effect.gen(function* () {
              names.add(name);
              if (names.size === 2) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(bothStarted);
              return yield* fixture.port.current(name);
            }),
        };
        const snapshot = yield* captured(port).pipe(Effect.timeout("1 second"));
        expect(snapshot.public.stableVersionId).toBe(versions.publicStable);
        expect(snapshot.core.stableVersionId).toBe(versions.coreStable);
        expect(fixture.changes).toEqual([]);
      })
    ));

  it.each([publicName, coreName])(
    "refuses capture when the %s read fails without traffic writes",
    (name) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fixture = harness();
          const port: ReleasePort = {
            ...fixture.port,
            current: (worker) =>
              worker === name
                ? Effect.fail(Error("read unavailable"))
                : fixture.port.current(worker),
          };
          yield* failure(captured(port), "read unavailable");
          expect(fixture.changes).toEqual([]);
        })
      )
  );
  it("keeps stable versions at 100% while staging exact candidates", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        yield* staged(fixture.port);
        expect((yield* fixture.port.current(publicName)).versions).toEqual([
          { id: versions.publicStable, percentage: 100 },
          { id: versions.publicCandidate, percentage: 0 },
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
          { id: versions.coreCandidate, percentage: 0 },
        ]);
      })
    ));

  it("removes a failed smoke candidate without changing stable traffic", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        yield* releaseCleanup.cleanRelease(fixture.port, release.snapshot, candidates);
        expect((yield* fixture.port.current(publicName)).versions).toEqual([
          { id: versions.publicStable, percentage: 100 },
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
      })
    ));

  it("confirms cleanup through a stale read without repeating a committed traffic write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const oldPublic = yield* fixture.port.current(publicName);
        let stale = false;
        const port: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            Effect.gen(function* () {
              const result = yield* fixture.port.deploy(name, entries);
              stale = name === publicName;
              return result;
            }),
          current: (name) => {
            if (name === publicName && stale) {
              stale = false;
              return Effect.succeed(oldPublic);
            }
            return fixture.port.current(name);
          },
        };
        yield* releaseCleanup.cleanRelease(port, release.snapshot, candidates);
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${publicName}:100`,
          `${coreName}:100`,
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
      })
    ));

  it("finishes both candidate cleanups when the first committed response is lost, without repeating a write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const ambiguous: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            fixture.port.deploy(name, entries).pipe(
              Effect.filterOrFail(
                () => name !== publicName,
                () => Error("response lost")
              )
            ),
        };
        yield* releaseCleanup.cleanRelease(ambiguous, release.snapshot, candidates);
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${publicName}:100`,
          `${coreName}:100`,
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
      })
    ));

  it("cleans only its own partially staged candidate after a Core staging failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const snapshot = yield* captured(fixture.port);
        fixture.fail(`${coreName}:100/0`);
        yield* failure(
          releaseController.stageRelease(fixture.port, snapshot, candidates),
          "write not confirmed"
        );
        yield* releaseCleanup.cleanRelease(fixture.port, snapshot, candidates);
        expect((yield* fixture.port.current(publicName)).versions).toEqual([
          { id: versions.publicStable, percentage: 100 },
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
      })
    ));

  it("refuses to clean an unknown staged version", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const snapshot = yield* captured(fixture.port);
        yield* fixture.port.deploy(publicName, [
          { id: versions.publicStable, percentage: 100 },
          { id: versions.coreCandidate, percentage: 0 },
        ]);
        yield* failure(
          releaseCleanup.cleanRelease(fixture.port, snapshot, candidates),
          "unexpected"
        );
        expect(fixture.changes).toHaveLength(1);
      })
    ));

  it("refuses superseded work without changing traffic", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const snapshot = yield* captured(fixture.port);
        fixture.supersede();
        yield* failure(
          releaseController.stageRelease(fixture.port, snapshot, candidates),
          "superseded"
        );
        expect(fixture.changes).toEqual([]);
      })
    ));

  it("refuses to overwrite a changed deployment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const snapshot = yield* captured(fixture.port);
        yield* fixture.port.deploy(coreName, [{ id: versions.coreCandidate, percentage: 100 }]);
        yield* failure(
          releaseController.stageRelease(fixture.port, snapshot, candidates),
          "changed"
        );
        expect(fixture.changes).toHaveLength(1);
      })
    ));

  it("promotes the tested pair in Core-first order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        yield* releaseController.promoteRelease(fixture.port, release, {
          exactPairPassed: true,
          middlePairPassed: true,
        });
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${coreName}:100`,
          `${publicName}:100`,
        ]);
        expect((yield* fixture.port.current(publicName)).versions).toEqual([
          { id: versions.publicCandidate, percentage: 100 },
        ]);
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreCandidate, percentage: 100 },
        ]);
      })
    ));

  it("retries an eventually consistent deployment read without writing traffic twice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const priorCore = yield* fixture.port.current(coreName);
        let staleRead = false;
        const delayed: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            Effect.gen(function* () {
              const result = yield* fixture.port.deploy(name, entries);
              staleRead =
                name === coreName &&
                entries[0]?.id === versions.coreCandidate &&
                entries.length === 1;
              return result;
            }),
          current: (name) =>
            Effect.gen(function* () {
              if (name === coreName && staleRead) {
                staleRead = false;
                return priorCore;
              }
              return yield* fixture.port.current(name);
            }),
        };
        yield* releaseController.promoteRelease(delayed, release, {
          exactPairPassed: true,
          middlePairPassed: true,
        });
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${coreName}:100`,
          `${publicName}:100`,
        ]);
      })
    ));

  it("confirms a committed Core promotion without repeating the write when its response was lost", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const ambiguous: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            fixture.port.deploy(name, entries).pipe(
              Effect.filterOrFail(
                () =>
                  name !== coreName ||
                  entries[0]?.id !== versions.coreCandidate ||
                  entries.length !== 1,
                () => Error("response lost after Core commit")
              )
            ),
        };
        yield* releaseController.promoteRelease(ambiguous, release, {
          exactPairPassed: true,
          middlePairPassed: true,
        });
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreCandidate, percentage: 100 },
        ]);
        expect((yield* fixture.port.current(publicName)).versions).toEqual([
          { id: versions.publicCandidate, percentage: 100 },
        ]);
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${coreName}:100`,
          `${publicName}:100`,
        ]);
      })
    ));

  it("refuses an unknown deployment after an ambiguous write and never repeats that write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const unknown: ReleasePort = {
          ...fixture.port,
          deploy: (name) =>
            fixture.port
              .deploy(name, [{ id: versions.coreCandidate, percentage: 100 }])
              .pipe(Effect.andThen(Effect.fail(Error("response lost")))),
        };
        yield* failure(
          releaseController.deployExact(unknown, publicName, [
            { id: versions.publicCandidate, percentage: 100 },
          ]),
          "write not confirmed"
        );
        expect(fixture.changes).toEqual([`${publicName}:100`]);
      })
    ));

  it("confirms a committed staging write when the adapter returns the preceding deployment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const previous = yield* fixture.port.current(publicName);
        const stale: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) => fixture.port.deploy(name, entries).pipe(Effect.as(previous)),
        };
        const result = yield* releaseController.deployExact(stale, publicName, [
          { id: versions.publicStable, percentage: 100 },
          { id: versions.publicCandidate, percentage: 0 },
        ]);
        expect(result.id).not.toBe(previous.id);
        expect(result.versions).toEqual([
          { id: versions.publicStable, percentage: 100 },
          { id: versions.publicCandidate, percentage: 0 },
        ]);
        expect(fixture.changes).toEqual([`${publicName}:100/0`]);
      })
    ));

  it("does not promote if either pairing fails smoke", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        yield* failure(
          releaseController.promoteRelease(fixture.port, release, {
            exactPairPassed: true,
            middlePairPassed: false,
          }),
          "smoke"
        );
        expect(fixture.changes).toHaveLength(2);
      })
    ));

  it("leaves stable traffic untouched if trunk moves while smoke runs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        fixture.supersede();
        yield* failure(
          releaseController.promoteRelease(fixture.port, release, {
            exactPairPassed: true,
            middlePairPassed: true,
          }),
          "superseded"
        );
        expect(fixture.changes).toHaveLength(2);
      })
    ));

  it("refuses promotion if a staged deployment changed after smoke", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        yield* fixture.port.deploy(publicName, [{ id: versions.publicCandidate, percentage: 100 }]);
        yield* failure(
          releaseController.promoteRelease(fixture.port, release, {
            exactPairPassed: true,
            middlePairPassed: true,
          }),
          "changed"
        );
        expect((yield* fixture.port.current(coreName)).versions[0]).toEqual({
          id: versions.coreStable,
          percentage: 100,
        });
      })
    ));

  it("confirms a committed public promotion without retry or Core rollback when its response was lost", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const original = fixture.port;
        const ambiguous: ReleasePort = {
          ...original,
          deploy: (name, entries) =>
            original.deploy(name, entries).pipe(
              Effect.filterOrFail(
                () => name !== publicName || entries.length !== 1,
                () => Error("response lost after commit")
              )
            ),
        };
        yield* releaseController.promoteRelease(ambiguous, release, {
          exactPairPassed: true,
          middlePairPassed: true,
        });
        expect((yield* original.current(publicName)).versions).toEqual([
          { id: versions.publicCandidate, percentage: 100 },
        ]);
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${coreName}:100`,
          `${publicName}:100`,
        ]);
        expect((yield* original.current(coreName)).versions).toEqual([
          { id: versions.coreCandidate, percentage: 100 },
        ]);
      })
    ));

  it("checks traffic and restores Core after an unexpected public adapter defect", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const defective: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            name === publicName && entries.length === 1
              ? Effect.die(Error("unexpected adapter failure"))
              : fixture.port.deploy(name, entries),
        };
        yield* failure(
          releaseController.promoteRelease(defective, release, {
            exactPairPassed: true,
            middlePairPassed: true,
          }),
          "restored"
        );
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
      })
    ));

  it("does not swallow interruption to attempt another traffic write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        const interrupted: ReleasePort = {
          ...fixture.port,
          deploy: (name, entries) =>
            name === publicName && entries.length === 1
              ? Effect.interrupt
              : fixture.port.deploy(name, entries),
        };
        const exit = yield* Effect.exit(
          releaseController.promoteRelease(interrupted, release, {
            exactPairPassed: true,
            middlePairPassed: true,
          })
        );
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(fixture.changes).toEqual([
          `${publicName}:100/0`,
          `${coreName}:100/0`,
          `${coreName}:100`,
        ]);
      })
    ));

  it("restores stable Core when public promotion fails without committing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = harness();
        const release = yield* staged(fixture.port);
        fixture.fail(`${publicName}:100`);
        yield* failure(
          releaseController.promoteRelease(fixture.port, release, {
            exactPairPassed: true,
            middlePairPassed: true,
          }),
          "restored"
        );
        expect((yield* fixture.port.current(coreName)).versions).toEqual([
          { id: versions.coreStable, percentage: 100 },
        ]);
        expect((yield* fixture.port.current(publicName)).versions[0]).toEqual({
          id: versions.publicStable,
          percentage: 100,
        });
      })
    ));
});
