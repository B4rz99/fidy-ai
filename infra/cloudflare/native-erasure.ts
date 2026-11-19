import { Effect, Option, Schedule } from "effect";
import { type UserObjects, newStoredUser, physicalErasure } from "./native-erasure-evidence";

type Browser = Readonly<{ id: string; outcome: string; headers: Readonly<Record<string, string>> }>;
type Checkpoint =
  | { stage: "stable-users"; populated: number }
  | { stage: "fresh-object"; physicalObject: string }
  | { stage: "admitted" | "physically-erased"; physicalObject: string; reference: string };

export type ErasureObservation = {
  inventory: () => Effect.Effect<UserObjects, Error>;
  record: (checkpoint: Checkpoint) => Effect.Effect<void, Error>;
};
type Port = ErasureObservation & {
  signup: () => Effect.Effect<Browser, Error>;
  admit: (browser: Browser) => Effect.Effect<string, Error>;
  denied: (browser: Browser) => Effect.Effect<void, Error>;
  survivors: () => Effect.Effect<ReadonlyArray<string>, Error>;
  renew: () => Effect.Effect<void, Error>;
};

const observed = <A>(
  read: Effect.Effect<Option.Option<A>, Error>,
  times: number,
  spacing: "5 seconds" | "20 seconds"
): Effect.Effect<A, Error> =>
  read.pipe(
    Effect.repeat({ while: Option.isNone, times, schedule: Schedule.spaced(spacing) }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(Error("Required physical User transition was not observed")),
        onSome: Effect.succeed,
      })
    )
  );

/** The protected release owns the closed installation's only signup during the physical census. */
export const verifyIndependentErasure = Effect.fn(function* (port: Port) {
  const retained = yield* port.survivors();
  if (new Set(retained).size !== 2)
    return yield* Effect.fail(Error("Expected two stable smoke Users"));
  // Shared bootstrap initializes one fixed UserStore probe in addition to the two smoke Users.
  const before = yield* observed(
    port
      .inventory()
      .pipe(
        Effect.map((rows) =>
          [...rows.values()].filter(Boolean).length >= 3 ? Option.some(rows) : Option.none()
        )
      ),
    12,
    "5 seconds"
  );
  yield* port.record({
    stage: "stable-users",
    populated: [...before.values()].filter(Boolean).length,
  });
  const disposable = yield* port.signup();
  if (disposable.outcome !== "created" || retained.includes(disposable.id)) {
    return yield* Effect.fail(Error("A fresh, independent synthetic User is required"));
  }
  const target = yield* observed(
    port.inventory().pipe(Effect.map((current) => newStoredUser(before, current))),
    12,
    "5 seconds"
  );
  yield* port.record({ stage: "fresh-object", physicalObject: target });
  yield* port.renew();
  const reference = yield* port.admit(disposable);
  yield* port.record({ stage: "admitted", physicalObject: target, reference });
  if ((yield* port.admit(disposable)) !== reference) {
    return yield* Effect.fail(Error("Erasure admission returned a different reference"));
  }
  const check = port.inventory().pipe(Effect.map((rows) => physicalErasure(before, target, rows)));
  const state = yield* observed(port.renew().pipe(Effect.andThen(check)), 30, "20 seconds");
  yield* port.record({ stage: "physically-erased", physicalObject: target, reference });
  yield* port.denied(disposable);
  const surviving = yield* port.survivors();
  if (retained.some((id, index) => id !== surviving[index]) || Option.isNone(yield* check)) {
    return yield* Effect.fail(
      Error("Physical erasure or stable User survival could not be confirmed")
    );
  }
  return {
    reference,
    physicalObject: target,
    physicalStateBefore: "stored",
    physicalStateAfter: state,
    admissionReplay: "same-reference",
    survivingUsers: retained.length,
    custodianCompletion: "unverified",
    recoveryWindow: "pending",
  } as const;
});
