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
  watch: (physicalObject: string) => Effect.Effect<void, Error>;
  record: (event: Readonly<Record<string, string | number>>) => Effect.Effect<void, Error>;
};
const maximumExistingObjects = 36;
const censusPolls = 12;
const cleanupPolls = 90;
const waitFor = <A>(
  read: Effect.Effect<Option.Option<A>, Error>,
  times: number
): Effect.Effect<A, Error> =>
  read.pipe(
    Effect.repeat({ while: Option.isNone, times, schedule: Schedule.spaced("5 seconds") }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(Error("Physical User transition unavailable")),
        onSome: Effect.succeed,
      })
    )
  );

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
  // Even an absent census or refused subsequent sample ends through this User's own erasure.
  const reference = yield* member.erase();
  yield* port.record({ stage: "erasure-admitted", reference });
  yield* port.renew();
  if (Option.isSome(physical)) {
    const subject = physical.value;
    const state = yield* waitFor(
      Effect.gen(function* () {
        yield* port.renew();
        const current = yield* port.inventory();
        return yield* Effect.try(() => physicalErasure({ before, current, subject }));
      }),
      cleanupPolls
    );
    yield* port.record({ stage: "physically-erased", state, physicalObject: subject });
  }
  yield* member.denied();
});

/** One synthetic lifetime, from independently observed population to confirmed physical disposal. */
export const runFleetPilot = Effect.fn(function* (port: Port) {
  const before = yield* port.inventory();
  if (before.size >= maximumExistingObjects) {
    return yield* Effect.fail(Error("Existing User inventory exceeds the pilot sizing envelope"));
  }
  yield* port.record({ stage: "census", existingObjects: before.size });
  const targetFromCensus = waitFor(
    Effect.suspend(port.inventory).pipe(
      Effect.flatMap((current) => Effect.try(() => newStoredUser({ before, current })))
    ),
    censusPolls
  );
  const registration = yield* Effect.exit(port.register());
  let physical: Option.Option<string> = Option.none();
  let member: Member;
  if (registration._tag === "Success") {
    member = registration.value;
    if (member.outcome !== "created") return yield* Effect.fail(Error("Fresh fleet User required"));
  } else {
    yield* port.record({ stage: "signup-reply-unconfirmed" });
    // A single independently populated object permits one login-only recovery, never another signup.
    physical = Option.some(yield* targetFromCensus);
    member = yield* port.login();
    if (member.outcome !== "approved")
      return yield* Effect.fail(Error("Established session required"));
  }
  const observation = yield* Effect.exit(
    Effect.gen(function* () {
      if (registration._tag === "Failure") return yield* Effect.failCause(registration.cause);
      const target = yield* targetFromCensus;
      physical = Option.some(target);
      yield* port.record({
        stage: "observation-start",
        physicalObject: target,
        at: yield* Clock.currentTimeMillis,
      });
      yield* port.watch(target);
      yield* port.record({ stage: "observation-end", at: yield* Clock.currentTimeMillis });
    })
  );

  yield* cleanupPilot({ port, member, before, physical });
  if (observation._tag === "Failure") return yield* Effect.failCause(observation.cause);
});
