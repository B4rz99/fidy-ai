import { Effect, Exit } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  type RetentionCompatibilityPort,
  decodeRetentionVersionRevision,
  requireRetentionMigration,
  requireRetentionRollback,
} from "./retention-migration-compatibility";
import { type Deployment, type ReleaseSnapshot } from "./release-controller";

const versionId = "11111111-1111-4111-8111-111111111111";
const stableRevision = "a".repeat(40);
const snapshot: ReleaseSnapshot = {
  revision: "b".repeat(40),
  stableRevision,
  stableContractDigest: "c".repeat(64),
  public: { name: "public", deploymentId: versionId, stableVersionId: versionId },
  core: { name: "core", deploymentId: versionId, stableVersionId: versionId },
};
const stable: Deployment = {
  id: versionId,
  versions: [{ id: versionId, percentage: 100 }],
};
const version = (bindings: unknown): unknown => ({
  success: true,
  result: {
    id: versionId,
    resources: { bindings },
  },
});

it("reads the immutable revision and rejects missing, ambiguous, secret, or mismatched versions", () => {
  const binding = { name: "RELEASE_GIT_SHA", type: "plain_text", text: stableRevision };
  expect(decodeRetentionVersionRevision(version([binding]), versionId)).toBe(stableRevision);
  expect(decodeRetentionVersionRevision(version({ RELEASE_GIT_SHA: binding }), versionId)).toBe(
    stableRevision
  );
  for (const bindings of [
    [],
    [binding, binding],
    {},
    [{ ...binding, type: "secret_text" }],
    [{ ...binding, text: "trunk" }],
    [{ ...binding, name: "UNRELATED" }],
  ]) {
    expect(() => decodeRetentionVersionRevision(version(bindings), versionId)).toThrow();
  }
  expect(() =>
    decodeRetentionVersionRevision(version([binding]), "22222222-2222-4222-8222-222222222222")
  ).toThrow();
});

it.effect(
  "checks the serving Core, the captured rollback version and candidate ancestry before migration",
  () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      const port: RetentionCompatibilityPort = {
        current: (name) =>
          Effect.sync(() => {
            observed.push(name);
            return stable;
          }),
        revision: (name, id) =>
          Effect.sync(() => {
            observed.push(`${name}:${id}`);
            return stableRevision;
          }),
        requireCompatible: (revision) =>
          Effect.sync(() => {
            observed.push(revision);
          }),
      };
      yield* requireRetentionMigration(port, snapshot);
      expect(observed).toEqual([
        "core",
        `core:${versionId}`,
        stableRevision,
        snapshot.revision,
        "core",
      ]);
    })
);

it.effect.each([
  "mixed traffic",
  "changed deployment",
  "zero traffic",
  "missing traffic",
  "source unavailable",
  "source mismatch",
  "incompatible stable",
  "incompatible candidate",
  "changed after proof",
] as const)("refuses migration when %s", (failure) =>
  Effect.gen(function* () {
    let reads = 0;
    const port: RetentionCompatibilityPort = {
      current: () =>
        Effect.sync(() => {
          reads++;
          if (failure === "mixed traffic") {
            return {
              ...stable,
              versions: [
                { id: versionId, percentage: 99 },
                { id: "22222222-2222-4222-8222-222222222222", percentage: 1 },
              ],
            };
          }
          if (
            failure === "changed deployment" ||
            (failure === "changed after proof" && reads === 2)
          ) {
            return { ...stable, id: "changed" };
          }
          if (failure === "missing traffic") return { ...stable, versions: [] };
          if (failure === "zero traffic") {
            return { ...stable, versions: [{ id: versionId, percentage: 0 }] };
          }
          return stable;
        }),
      revision: () =>
        failure === "source unavailable"
          ? Effect.fail(Error("unavailable"))
          : Effect.succeed(failure === "source mismatch" ? "d".repeat(40) : stableRevision),
      requireCompatible: (revision) =>
        (failure === "incompatible stable" && revision === stableRevision) ||
        (failure === "incompatible candidate" && revision === snapshot.revision)
          ? Effect.fail(Error("not an ancestor"))
          : Effect.void,
    };
    expect(Exit.isFailure(yield* Effect.exit(requireRetentionMigration(port, snapshot)))).toBe(
      true
    );
  })
);

it.effect(
  "refuses a pre-compatibility rollback receipt even while its deployment IDs still match",
  () =>
    Effect.gen(function* () {
      const port: RetentionCompatibilityPort = {
        current: () => Effect.succeed(stable),
        revision: () => Effect.succeed(stableRevision),
        requireCompatible: () => Effect.fail(Error("pre-compatibility rollback")),
      };
      expect(Exit.isFailure(yield* Effect.exit(requireRetentionRollback(port, snapshot)))).toBe(
        true
      );
    })
);
