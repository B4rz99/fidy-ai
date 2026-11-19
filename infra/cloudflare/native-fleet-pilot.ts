import { Clock, Effect, Option, Schedule } from "effect";
import { type UserObjects, newStoredUser, physicalErasure } from "./native-erasure-evidence";

type Member = {
  outcome: string;
  erase: () => Effect.Effect<string, Error>;
  denied: () => Effect.Effect<void, Error>;
};
export type FleetPilotBrowser = {
  register: () => Effect.Effect<Member, Error>;
  login: () => Effect.Effect<Member, Error>;
  renew: () => Effect.Effect<void, Error>;
};
type Port = FleetPilotBrowser & {
  inventory: () => Effect.Effect<UserObjects, Error>;
  beforeSignup: () => Effect.Effect<void, Error>;
  renewCleanup: () => Effect.Effect<void, Error>;
  watch: (physicalObject: string) => Effect.Effect<void, Error>;
  record: (event: Readonly<Record<string, string | number>>) => Effect.Effect<void, Error>;
};
// The admitted erasure checkpoint pins native-erasure.ts byte-for-byte to its source revision.
const populated = (rows: UserObjects): number => [...rows.values()].filter(Boolean).length;
const observePhysicalCensus = Effect.fn(function* <Value>(
  port: Port,
  stage: "waiting-baseline" | "waiting-fresh-object" | "waiting-physical-erasure",
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

const maximumExistingObjects = 36;
const establishedOwners = 3;
const baseline = (rows: UserObjects): Option.Option<UserObjects> =>
  populated(rows) >= establishedOwners ? Option.some(rows) : Option.none();

const cleanupPilot = Effect.fn(function* ({
  port,
  member,
  before,
  physical,
}: {
  port: Port;
  member: Member;
  before: UserObjects;
  physical: Option.Option<string>;
}) {
  // Submit the same authenticated User's erasure even when foreground metering or logging failed.
  const starting = yield* Effect.exit(port.record({ stage: "erasure-submission-started" }));
  yield* Effect.exit(port.renewCleanup().pipe(Effect.timeout("1 minute")));
  const admission = yield* Effect.exit(member.erase().pipe(Effect.timeout("2 minutes")));
  const receipt: Readonly<Record<string, string>> =
    admission._tag === "Success"
      ? { stage: "erasure-admitted", reference: admission.value }
      : { stage: "erasure-reply-unconfirmed" };
  const recorded = yield* Effect.exit(port.record(receipt));
  if (Option.isSome(physical)) {
    const subject = physical.value;
    const state = yield* observePhysicalCensus(
      { ...port, renew: port.renewCleanup },
      "waiting-physical-erasure",
      (current) => physicalErasure({ before, current, subject })
    );
    yield* port.record({ stage: "physically-erased", state, physicalObject: subject });
  } else {
    yield* port.renewCleanup();
  }
  yield* member.denied().pipe(Effect.timeout("1 minute"));
  if (admission._tag === "Failure") return yield* Effect.failCause(admission.cause);
  if (starting._tag === "Failure") return yield* Effect.failCause(starting.cause);
  if (recorded._tag === "Failure") return yield* Effect.failCause(recorded.cause);
});

/** One synthetic lifetime, from independently observed population to confirmed physical disposal. */
export const runFleetPilot = Effect.fn(function* (port: Port) {
  const before = yield* observePhysicalCensus(port, "waiting-baseline", baseline);
  if (before.size >= maximumExistingObjects) {
    return yield* Effect.fail(Error("Existing User inventory exceeds the pilot sizing envelope"));
  }
  yield* port.record({ stage: "census", existingObjects: before.size });
  const targetFromCensus = observePhysicalCensus(port, "waiting-fresh-object", (current) =>
    newStoredUser({ before, current })
  );
  yield* port.beforeSignup();
  yield* port.record({ stage: "signup-started" });
  const registration = yield* Effect.exit(port.register().pipe(Effect.timeout("2 minutes")));
  let physical: Option.Option<string> = Option.none();
  let member: Member;
  if (registration._tag === "Success") {
    member = registration.value;
    if (member.outcome !== "created") return yield* Effect.fail(Error("Fresh fleet User required"));
  } else {
    yield* port.record({ stage: "signup-reply-unconfirmed" });
    // A single independently populated object permits one login-only recovery, never another signup.
    physical = Option.some(yield* targetFromCensus);
    member = yield* port.login().pipe(Effect.timeout("2 minutes"));
    if (member.outcome !== "approved") {
      return yield* Effect.fail(Error("Established session required"));
    }
  }
  const observation = yield* Effect.exit(
    Effect.gen(function* () {
      if (registration._tag === "Failure") return yield* Effect.failCause(registration.cause);
      yield* port.record({ stage: "signup-created" });
      const target = yield* targetFromCensus;
      physical = Option.some(target);
      yield* port.record({
        stage: "observation-start",
        physicalObject: target,
        at: yield* Clock.currentTimeMillis,
      });
      yield* port.watch(target).pipe(Effect.timeout("12 minutes"));
      yield* port.record({ stage: "observation-end", at: yield* Clock.currentTimeMillis });
    })
  );

  yield* cleanupPilot({ port, member, before, physical });
  if (observation._tag === "Failure") return yield* Effect.failCause(observation.cause);
});
