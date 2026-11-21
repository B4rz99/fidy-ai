import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, Option, Predicate, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { verifyIndependentErasure } from "./native-erasure";
import { newStoredUser, physicalErasure, readUserObjects } from "./native-erasure-evidence";

it.effect("pins the only new stored User and requires its own storage to disappear", () =>
  Effect.sync(() => {
    const before = new Map([
      ["one", true],
      ["two", true],
    ]);

    const active = new Map([...before, ["third", true]] as const);
    expect(newStoredUser({ before, current: active })).toEqual(Option.some("third"));
    expect(newStoredUser({ before, current: before })).toEqual(Option.none());
    expect(() =>
      newStoredUser({ before, current: new Map([...active, ["extra", true]]) })
    ).toThrow();
    expect(() =>
      newStoredUser({ before, current: new Map([...active, ["two", false]]) })
    ).toThrow();
    expect(physicalErasure({ before, subject: "third", current: active })).toEqual(Option.none());
    expect(
      physicalErasure({ before, subject: "third", current: new Map([...active, ["third", false]]) })
    ).toEqual(Option.some("empty"));
    expect(physicalErasure({ before, subject: "third", current: before })).toEqual(
      Option.some("absent")
    );
    expect(() =>
      physicalErasure({ before, subject: "third", current: new Map([["one", true]]) })
    ).toThrow();
  })
);

it.effect(
  "reads every cursor page and rejects a repeated cursor or an unverified storage flag",
  () =>
    Effect.gen(function* () {
      const id = "a".repeat(64);
      const next = "b".repeat(64);

      const page = (cursor: string, id: string): Schema.Json => ({
        success: true,
        result: [{ id, hasStoredData: true }],
        result_info: { cursors: { after: cursor } },
      });

      const lookup = (path: string): Effect.Effect<Schema.Json> =>
        Effect.succeed(path.includes("cursor=next") ? page("", next) : page("next", id));

      expect(yield* readUserObjects(lookup, "c".repeat(32))).toEqual(
        new Map([
          [id, true],
          [next, true],
        ])
      );

      yield* Effect.forEach(
        [page("repeat", id), { success: true, result: [{ id }], result_info: {} }],
        Effect.fnUntraced(function* (bad) {
          expect(
            yield* Effect.isFailure(readUserObjects(() => Effect.succeed(bad), "c".repeat(32)))
          ).toBe(true);
        }),
        { discard: true }
      );
    })
);

it.effect(
  "an ambiguous signup cannot admit erasure, and a denied browser alone never verifies physical erasure",
  () =>
    Effect.gen(function* () {
      const retained = new Map([
        ["probe", true],
        ["one", true],
        ["two", true],
      ]);

      const third = { id: "third", outcome: "created", headers: {} };
      let signedUp = false;
      let admitted = 0;

      const check = yield* Effect.exit(
        verifyIndependentErasure({
          record: () => Effect.void,
          inventory: () =>
            Effect.sync(() =>
              signedUp ? new Map([...retained, ["third", true], ["another", true]]) : retained
            ),
          signup: () =>
            Effect.sync(() => {
              signedUp = true;

              return third;
            }),
          survivors: () => Effect.succeed(["one", "two"]),
          admit: () =>
            Effect.sync(() => {
              admitted++;

              return "receipt";
            }),
          renew: () => Effect.void,
          denied: () => Effect.void,
        })
      );

      expect(check._tag).toBe("Failure");
      expect(admitted).toBe(0);
      expect(
        physicalErasure({
          before: retained,
          subject: "third",
          current: new Map([...retained, ["third", true]]),
        })
      ).toEqual(Option.none());
    })
);

it.effect(
  "retains the same two Users after the independent physical erasure of a newly admitted third",
  () =>
    Effect.gen(function* () {
      const stored = new Map([
        ["probe", true],
        ["one", true],
        ["two", true],
      ]);

      const checkpoints: string[] = [];
      const subject = { id: "third", outcome: "created", headers: {} };

      const result = yield* verifyIndependentErasure({
        inventory: () => Effect.sync(() => new Map(stored)),
        signup: () =>
          Effect.sync(() => {
            stored.set("physical-third", true);

            return subject;
          }),
        admit: (user) =>
          Effect.sync(() => {
            expect(user.id).toBe("third");

            return "original-reference";
          }),
        record: (checkpoint) =>
          Effect.sync(() => {
            checkpoints.push(checkpoint.stage);

            if (checkpoint.stage === "admitted") stored.set("physical-third", false);
          }),
        survivors: () => Effect.succeed(["one", "two"]),
        denied: (user) =>
          Effect.sync(() => {
            expect(user.id).toBe("third");
          }),
        renew: () => Effect.void,
      });

      expect(result).toMatchObject({
        admissionReplay: "same-reference",
        physicalObject: "physical-third",
        physicalStateAfter: "empty",
        survivingUsers: 2,
        custodianCompletion: "unverified",
      });
      expect(checkpoints.filter((stage) => !stage.startsWith("waiting-"))).toEqual([
        "stable-users",
        "signup-started",
        "signup-created",
        "fresh-object",
        "admission-started",
        "admitted",
        "physically-erased",
      ]);
    })
);

it.effect(
  "waits through delayed baseline, signup and erasure census updates without repeating signup",
  () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const minute = 60_000;

      const retained = new Map([
        ["probe", true],
        ["one", true],
        ["two", true],
      ]);

      const fresh = new Map([...retained, ["physical-third", true]] as const);
      const stages: string[] = [];

      let signedUp = 0,
        admitted = 0;

      const runner = yield* verifyIndependentErasure({
        inventory: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const elapsed = now - start;

              if (elapsed < 8 * minute) {
                return new Map([
                  ["one", true],
                  ["two", true],
                ]);
              }

              if (elapsed < 16 * minute || elapsed >= 24 * minute) return retained;

              return fresh;
            })
          ),
        record: (checkpoint) =>
          Effect.sync(() => {
            stages.push(checkpoint.stage);
          }),
        signup: () =>
          Effect.sync(() => {
            expect(stages.at(-1)).toBe("signup-started");
            signedUp++;

            return { id: "third", outcome: "created", headers: {} };
          }),
        admit: () =>
          Effect.sync(() => {
            admitted++;

            return "receipt";
          }),
        survivors: () => Effect.succeed(["one", "two"]),
        renew: () => Effect.void,
        denied: () => Effect.void,
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("7 minutes");
      expect(signedUp).toBe(0);
      yield* TestClock.adjust("7 minutes");
      expect(signedUp).toBe(1);
      expect(stages).toContain("waiting-baseline");
      expect(admitted).toBe(0);
      expect(stages).toContain("waiting-fresh-object");
      yield* TestClock.adjust("6 minutes");
      expect(admitted).toBe(2);
      expect(stages).toContain("waiting-physical-erasure");
      yield* TestClock.adjust("5 minutes");
      expect((yield* Fiber.join(runner)).physicalStateAfter).toBe("absent");
      expect(signedUp).toBe(1);
    })
);

it.effect(
  "ends a stalled post-admission census without a second signup or a new erasure request",
  () =>
    Effect.gen(function* () {
      const before = new Map([
        ["probe", true],
        ["one", true],
        ["two", true],
      ]);

      const after = new Map([...before, ["subject", true]] as const);
      const stages: string[] = [];

      let signups = 0,
        admissions = 0;

      const result = yield* verifyIndependentErasure({
        inventory: () => Effect.sync(() => (signups === 0 ? before : after)),
        record: (checkpoint) =>
          Effect.sync(() => {
            stages.push(checkpoint.stage);
          }),
        survivors: () => Effect.succeed(["one", "two"]),
        renew: () => Effect.void,
        signup: () =>
          Effect.sync(() => {
            signups++;

            return { id: "disposable", outcome: "created", headers: {} };
          }),
        admit: () =>
          Effect.sync(() => {
            admissions++;

            return "same-reference";
          }),
        denied: () => Effect.die("Physical erasure has not been observed"),
      }).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("21 minutes");
      expect(Predicate.isTagged(yield* Fiber.join(result), "TimeoutError")).toBe(true);
      expect(signups).toBe(1);
      expect(admissions).toBe(2);
      expect(stages.at(-1)).toBe("waiting-physical-erasure");
      expect(stages).not.toContain("physically-erased");
    })
);
