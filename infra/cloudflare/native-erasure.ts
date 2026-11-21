import { Effect, Option, Schedule } from "effect";
import { type UserObjects, newStoredUser, physicalErasure } from "./native-erasure-evidence";

type Browser = Readonly<{ id: string; outcome: string; headers: Readonly<Record<string, string>> }>;

type CensusStage = "waiting-baseline" | "waiting-fresh-object" | "waiting-physical-erasure";

type Checkpoint =
  | { stage: CensusStage; observations: 0 }
  | { stage: CensusStage; observations: number; listed: number; populated: number }
  | { stage: "signup-started" | "signup-created" }
  | { stage: "stable-users"; populated: number }
  | { stage: "fresh-object" | "admission-started"; physicalObject: string }
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

const populated = (rows: UserObjects): number => [...rows.values()].filter(Boolean).length;

const observed = Effect.fn(function* <Value>(
  port: Port,
  stage: CensusStage,
  transition: (rows: UserObjects) => Option.Option<Value>
) {
  yield* port.record({ stage, observations: 0 });
  let observations = 0;

  const census = Effect.gen(function* () {
    if (stage === "waiting-physical-erasure") yield* port.renew();
    const rows = yield* port.inventory();
    yield* port.record({
      stage,
      observations: ++observations,
      listed: rows.size,
      populated: populated(rows),
    });

    return yield* Effect.try(() => transition(rows));
  });

  const found = yield* census.pipe(
    Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("30 seconds") }),
    Effect.timeout("20 minutes")
  );

  return yield* Effect.fromOption(found, () =>
    Error("Required physical User transition was not observed")
  );
});

const captureStableUsers = Effect.fn(function* (port: Port) {
  const retained = yield* port.survivors();

  if (new Set(retained).size !== 2) {
    return yield* Effect.fail(Error("Expected two stable smoke Users"));
  }

  const before = yield* observed(port, "waiting-baseline", (rows) =>
    populated(rows) >= 3 ? Option.some(rows) : Option.none()
  );

  yield* port.record({ stage: "stable-users", populated: populated(before) });

  return { before, retained };
});

export const verifyIndependentErasure = Effect.fn(function* (port: Port) {
  const { before, retained } = yield* captureStableUsers(port);
  yield* port.renew();
  yield* port.record({ stage: "signup-started" });
  const disposable = yield* port.signup();

  if (disposable.outcome !== "created" || retained.includes(disposable.id)) {
    return yield* Effect.fail(Error("A fresh, independent synthetic User is required"));
  }

  yield* port.record({ stage: "signup-created" });

  const target = yield* observed(port, "waiting-fresh-object", (current) =>
    newStoredUser({ before, current })
  );

  yield* port.record({ stage: "fresh-object", physicalObject: target });
  yield* port.renew();
  yield* port.record({ stage: "admission-started", physicalObject: target });
  const reference = yield* port.admit(disposable);
  yield* port.record({ stage: "admitted", physicalObject: target, reference });

  if ((yield* port.admit(disposable)) !== reference) {
    return yield* Effect.fail(Error("Erasure admission returned a different reference"));
  }

  const physicalState = (current: UserObjects): ReturnType<typeof physicalErasure> =>
    physicalErasure({ before, subject: target, current });

  const state = yield* observed(port, "waiting-physical-erasure", physicalState);
  yield* port.record({ stage: "physically-erased", physicalObject: target, reference });
  yield* port.denied(disposable);
  const surviving = yield* port.survivors();

  if (
    retained.some((id, index) => id !== surviving[index]) ||
    Option.isNone(physicalState(yield* port.inventory()))
  ) {
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
