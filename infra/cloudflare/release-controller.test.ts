import { TestClock } from "effect/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Option, type Scope } from "effect";
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

const advanceReleaseClock = <A, E, R>(
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    const pending = yield* Effect.forkScoped(work);
    yield* TestClock.adjust("30 seconds");
    return yield* Fiber.join(pending);
  });

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
        expected: { publicVersionId: versions.publicStable, coreVersionId: versions.coreStable },
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
          expected: { publicVersionId: versions.publicStable, coreVersionId: versions.coreStable },
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

  it.effect.each(["revision", "public", "core"] as const)(
    "refuses changed %s authority before isolation writes",
    (changed) =>
      Effect.gen(function* () {
        const fixture = harness();
        const snapshot = yield* captured(fixture.port);
        if (changed === "revision") fixture.supersede();
        const exit = yield* releaseController
          .isolateRelease(fixture.port, snapshot, {
            candidate: candidates,
            expected: {
              publicVersionId:
                changed === "public" ? versions.publicCandidate : versions.publicStable,
              coreVersionId: changed === "core" ? versions.coreCandidate : versions.coreStable,
            },
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
  it.effect.each([
    [{ id: versions.coreStable, percentage: 0 }],
    [
      { id: versions.coreStable, percentage: 99 },
      { id: versions.coreCandidate, percentage: 1 },
    ],
    [
      { id: versions.coreStable, percentage: 100 },
      { id: versions.coreCandidate, percentage: -1 },
    ],
    [
      { id: versions.coreStable, percentage: 100 },
      { id: versions.coreStable, percentage: 0 },
    ],
    [
      { id: versions.coreStable, percentage: 100 },
      { id: versions.coreCandidate, percentage: 0 },
      { id: versions.publicCandidate, percentage: 0 },
    ],
  ])("refuses capture of invalid routing %j before any release write", (entries) =>
    Effect.gen(function* () {
      const fixture = harness();
      yield* fixture.port.deploy(coreName, entries);
      const before = [...fixture.changes];
      expect(Exit.isFailure(yield* Effect.exit(captured(fixture.port)))).toBe(true);
      expect(fixture.changes).toEqual(before);
    })
  );

  it.effect("refuses a changed captured deployment before replacing a stranded candidate", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const baseline = [
        { id: versions.coreStable, percentage: 100 },
        { id: "55555555-5555-4555-8555-555555555555", percentage: 0 },
      ];
      yield* fixture.port.deploy(coreName, baseline);
      const snapshot = yield* captured(fixture.port);
      yield* fixture.port.deploy(coreName, baseline);
      const before = [...fixture.changes];
      expect(
        Exit.isFailure(
          yield* Effect.exit(releaseController.stageRelease(fixture.port, snapshot, candidates))
        )
      ).toBe(true);
      expect(fixture.changes).toEqual(before);
    })
  );

  it.effect("replaces a stranded zero-traffic candidate without rolling back changed secrets", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const abandoned = "55555555-5555-4555-8555-555555555555";
      const baseline = yield* fixture.port.deploy(coreName, [
        { id: versions.coreStable, percentage: 100 },
        { id: abandoned, percentage: 0 },
      ]);
      const writes: Deployment["versions"][] = [];
      const port: ReleasePort = {
        ...fixture.port,
        deploy: (name, entries) => {
          writes.push(entries);
          if (name === coreName && entries.length === 1 && entries[0]?.id === versions.coreStable) {
            return Effect.fail(Error("Cloudflare deployment rejected (HTTP 400; code 10220)"));
          }
          return fixture.port.deploy(name, entries);
        },
      };
      const snapshot = yield* captured(port);
      expect(snapshot.core.deploymentId).toBe(baseline.id);
      expect(snapshot.core.stableVersionId).toBe(versions.coreStable);
      expect(writes).toEqual([]);
      const release = yield* releaseController.stageRelease(port, snapshot, candidates);
      expect((yield* port.current(coreName)).versions).toEqual([
        { id: versions.coreStable, percentage: 100 },
        { id: versions.coreCandidate, percentage: 0 },
      ]);
      yield* releaseController.promoteRelease(port, release, {
        exactPairPassed: true,
        middlePairPassed: true,
      });
      expect((yield* port.current(coreName)).versions).toEqual([
        { id: versions.coreCandidate, percentage: 100 },
      ]);
    })
  );

  it.effect("captures both stable Workers with overlapping reads and no traffic writes", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect.each([publicName, coreName])(
    "refuses capture when the %s read fails without traffic writes",
    (name) =>
      advanceReleaseClock(
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
  it.effect("keeps stable versions at 100% while staging exact candidates", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("removes a failed smoke candidate without changing stable traffic", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect(
    "confirms cleanup through a stale read without repeating a committed traffic write",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect(
    "finishes both candidate cleanups when the first committed response is lost, without repeating a write",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect("cleans only its own partially staged candidate after a Core staging failure", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("refuses to clean an unknown staged version", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("refuses superseded work without changing traffic", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("refuses to overwrite a changed deployment", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("promotes the tested pair in Core-first order", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("retries an eventually consistent deployment read without writing traffic twice", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect(
    "confirms a committed Core promotion without repeating the write when its response was lost",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect(
    "refuses an unknown deployment after an ambiguous write and never repeats that write",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect(
    "confirms a committed staging write when the adapter returns the preceding deployment",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect("does not promote if either pairing fails smoke", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("leaves stable traffic untouched if trunk moves while smoke runs", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("refuses promotion if a staged deployment changed after smoke", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect(
    "confirms a committed public promotion without retry or Core rollback when its response was lost",
    () =>
      advanceReleaseClock(
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
      )
  );

  it.effect("checks traffic and restores Core after an unexpected public adapter defect", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("does not swallow interruption to attempt another traffic write", () =>
    advanceReleaseClock(
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
    )
  );

  it.effect("restores stable Core when public promotion fails without committing", () =>
    advanceReleaseClock(
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
    )
  );
});
