import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
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
    expect(newStoredUser(before, active)).toEqual(Option.some("third"));
    expect(newStoredUser(before, before)).toEqual(Option.none());
    expect(() => newStoredUser(before, new Map([...active, ["extra", true]]))).toThrow();
    expect(() => newStoredUser(before, new Map([...active, ["two", false]]))).toThrow();
    expect(physicalErasure(before, "third", active)).toEqual(Option.none());
    expect(physicalErasure(before, "third", new Map([...active, ["third", false]]))).toEqual(
      Option.some("empty")
    );
    expect(physicalErasure(before, "third", before)).toEqual(Option.some("absent"));
    expect(() => physicalErasure(before, "third", new Map([["one", true]]))).toThrow();
  })
);

it.effect(
  "reads every cursor page and rejects a repeated cursor or an unverified storage flag",
  () =>
    Effect.gen(function* () {
      const id = "a".repeat(64);
      const next = "b".repeat(64);
      const page = (cursor: string | null, id: string) => ({
        success: true,
        result: [{ id, hasStoredData: true }],
        result_info: { cursors: { after: cursor } },
      });
      const lookup = (path: string) =>
        Effect.succeed(path.includes("cursor=next") ? page(null, next) : page("next", id));
      expect(yield* readUserObjects(lookup, "c".repeat(32))).toEqual(
        new Map([
          [id, true],
          [next, true],
        ])
      );
      for (const bad of [
        page("repeat", id),
        { success: true, result: [{ id }], result_info: {} },
      ]) {
        expect(
          yield* Effect.isFailure(readUserObjects(() => Effect.succeed(bad), "c".repeat(32)))
        ).toBe(true);
      }
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
      expect(physicalErasure(retained, "third", new Map([...retained, ["third", true]]))).toEqual(
        Option.none()
      );
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
      expect(checkpoints).toEqual([
        "stable-users",
        "fresh-object",
        "admitted",
        "physically-erased",
      ]);
    })
);
