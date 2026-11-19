import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { continueAdmittedErasure } from "./native-erasure-continuation";

const original = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const target = "d".repeat(64);
const revision = "1".repeat(40);
const userNamespace = "2".repeat(32);
const reference = "00000000-0000-4000-8000-900000000001";
const baseline = new Bun.CryptoHasher("sha256").update(original.join("\n")).digest("hex");
const admitted = {
  revision, userNamespace, stage: "waiting-physical-erasure",
  checkpoints: [
    { stage: "stable-users", populated: 3 },
    { stage: "signup-created" },
    { stage: "fresh-object", physicalObject: target },
    { stage: "admitted", physicalObject: target, reference },
    { stage: "waiting-physical-erasure", observations: 1, listed: 4, populated: 4 },
  ],
};
const retained = new Map(original.map((id) => [id, true] as const));

it.effect("continues the original admitted evidence without a signup or erasure operation", () =>
  Effect.gen(function* () {
    const proof = yield* continueAdmittedErasure({
      checkpoint: admitted, revision, userNamespace, baseline,
      inventory: () => Effect.succeed(retained),
      renew: () => Effect.void,
      logins: () => Effect.succeed(["one", "two"]),
      refused: () => Effect.void,
    });
    expect(proof).toMatchObject({
      reference, physicalObject: target, physicalStateAfter: "absent",
      admissionReplay: "same-reference", survivingUsers: 2,
      originalBrowserSessionDenial: "unavailable",
      erasedProviderLogin: "refused",
    });
  })
);

it.effect("rejects substituted baseline objects, unrelated admissions and missing replay evidence", () =>
  Effect.gen(function* () {
    const options = {
      checkpoint: admitted, revision, userNamespace, baseline,
      inventory: () => Effect.succeed(retained),
      renew: () => Effect.void,
      logins: () => Effect.succeed(["one", "two"]),
      refused: () => Effect.void,
    };
    for (const changed of [
      { revision: "9".repeat(40) }, { userNamespace: "9".repeat(32) },
      { checkpoint: { ...admitted, checkpoints: admitted.checkpoints.slice(0, -1) } },
      { baseline: "9".repeat(64) },
      { inventory: () => Effect.succeed(new Map([...retained, ["e".repeat(64), true]])) },
      { logins: () => Effect.succeed(["one", "one"]) },
      { refused: () => Effect.fail(Error("Login approved")) },
    ]) {
      expect(yield* Effect.isFailure(continueAdmittedErasure({ ...options, ...changed }))).toBe(true);
    }
  })
);
