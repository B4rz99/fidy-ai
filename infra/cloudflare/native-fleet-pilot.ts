import { Clock, Effect, Option, Schedule } from "effect";
import { newStoredUser, physicalErasure, type UserObjects } from "./native-erasure-evidence";

type Member = {
  outcome: string;
  erase: () => Effect.Effect<string, Error>;
  denied: () => Effect.Effect<void, Error>;
};
type Port = {
  inventory: () => Effect.Effect<UserObjects, Error>;
  register: () => Effect.Effect<Member, Error>;
  renew: () => Effect.Effect<void, Error>;
  watch: (physicalObject: string) => Effect.Effect<void, Error>;
  record: (event: Readonly<Record<string, string | number>>) => Effect.Effect<void, Error>;
};
const maximumExistingObjects = 36;
const waitFor = <A>(read: Effect.Effect<Option.Option<A>, Error>, times: number) =>
  read.pipe(
    Effect.repeat({ while: Option.isNone, times, schedule: Schedule.spaced("5 seconds") }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(Error("Physical User transition unavailable")),
        onSome: Effect.succeed,
      })
    )
  );

/** One synthetic lifetime, from independently observed population to confirmed physical disposal. */
export const runFleetPilot = Effect.fn(function* (port: Port) {
  const before = yield* port.inventory();
  if (before.size >= maximumExistingObjects) {
    return yield* Effect.fail(Error("Existing User inventory exceeds the pilot sizing envelope"));
  }
  yield* port.record({ stage: "census", existingObjects: before.size });
  const member = yield* port.register();
  if (member.outcome !== "created") {
    return yield* Effect.fail(Error("Pilot requires one newly created synthetic User"));
  }
  let physical: Option.Option<string> = Option.none();
  const observation = yield* Effect.exit(
    Effect.gen(function* () {
      const target = yield* waitFor(
        port
          .inventory()
          .pipe(Effect.flatMap((current) => Effect.try(() => newStoredUser({ before, current })))),
        12
      );
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
      90
    );
    yield* port.record({ stage: "physically-erased", state, physicalObject: subject });
  }
  yield* member.denied();
  if (observation._tag === "Failure") return yield* Effect.failCause(observation.cause);
});
