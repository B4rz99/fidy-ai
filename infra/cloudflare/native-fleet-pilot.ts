import { Clock, Effect, Exit, Option, Result, Schedule } from "effect";
import { type UserObjects, newStoredUser, physicalErasure } from "./native-erasure-evidence";

type Member = {
  id: string;
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

const populated = (rows: UserObjects): number => [...rows.values()].filter(Boolean).length;

const observePhysicalCensus = Effect.fn(function* <Value>(
  port: Pick<Port, "inventory" | "record" | "renew">,
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

const submitErasure = Effect.fn(function* (member: Member, record: Port["record"]) {
  const admission = yield* Effect.exit(member.erase().pipe(Effect.timeout("2 minutes")));

  const receipt: Readonly<Record<string, string>> = Exit.isSuccess(admission)
    ? { stage: "erasure-admitted", reference: admission.value }
    : { stage: "erasure-reply-unconfirmed" };

  const recorded = yield* Effect.exit(record(receipt));

  return { admission, recorded };
});

const freshMember = Effect.fn(function* (member: Member, login: Port["login"]) {
  if (member.outcome === "approved") return member;
  const fresh = yield* login().pipe(Effect.timeout("2 minutes"));

  if (fresh.outcome !== "approved" || fresh.id !== member.id) {
    return yield* Effect.fail(Error("Fresh login did not identify the original fleet User"));
  }

  return fresh;
});

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
  yield* Effect.exit(port.renewCleanup().pipe(Effect.timeout("1 minute")));
  const fresh = yield* freshMember(member, port.login);
  const starting = yield* Effect.exit(port.record({ stage: "erasure-submission-started" }));
  const { admission, recorded } = yield* submitErasure(fresh, port.record);

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

  if (Exit.isFailure(admission)) return yield* Effect.failCause(admission.cause);

  if (Exit.isFailure(starting)) return yield* Effect.failCause(starting.cause);

  if (Exit.isFailure(recorded)) return yield* Effect.failCause(recorded.cause);
});

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

  if (Exit.isSuccess(registration)) {
    member = registration.value;

    if (member.outcome !== "created") return yield* Effect.fail(Error("Fresh fleet User required"));
  } else {
    yield* port.record({ stage: "signup-reply-unconfirmed" });
    physical = Option.some(yield* targetFromCensus);
    member = yield* port.login().pipe(Effect.timeout("2 minutes"));

    if (member.outcome !== "approved") {
      return yield* Effect.fail(Error("Established session required"));
    }
  }

  const observation = yield* Effect.exit(
    Effect.gen(function* () {
      if (Exit.isFailure(registration)) return yield* Effect.failCause(registration.cause);
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

  if (Exit.isFailure(observation)) return yield* Effect.failCause(observation.cause);
});

const digest = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

type Cleanup = Pick<Port, "inventory" | "login" | "record" | "renewCleanup"> & {
  target: string;
  targetSha256: string;
  userSha256: string;
  baselineSha256: string;
  refused: () => Effect.Effect<void, Error>;
  budget: (phase: "renew-cleanup" | "refusal") => Effect.Effect<void, Error>;
};

type Transition = (rows: UserObjects) => ReturnType<typeof physicalErasure>;

const eraseEstablished = Effect.fn(function* (input: Cleanup, transition: Transition) {
  yield* input.renewCleanup();
  const session = yield* input.login().pipe(Effect.timeout("2 minutes"), Effect.result);

  if (Result.isFailure(session)) {
    yield* input.record({ stage: "established-login-unconfirmed" });

    return Option.none<Member>();
  }

  const member = session.success;

  if (member.outcome !== "approved" || digest(member.id) !== input.userSha256) {
    return yield* Effect.fail(Error("Established login did not identify the archived fleet User"));
  }

  yield* input.record({ stage: "original-fleet-user-authenticated" });
  const current = yield* input.inventory();

  if (Option.isNone(yield* Effect.try(() => transition(current)))) {
    yield* input.budget("renew-cleanup");
    yield* input.record({ stage: "erasure-submission-started" });
    const { recorded } = yield* submitErasure(member, input.record);

    if (Exit.isFailure(recorded)) return yield* Effect.failCause(recorded.cause);
  }

  return Option.some(member);
});

export const continueFleetCleanup = Effect.fn(function* (input: Cleanup) {
  const initial = yield* input.inventory();
  const before = new Map(initial);
  before.delete(input.target);

  const retained = [...before]
    .map(([id, stored]) => id + ":" + stored)
    .sort()
    .join("\n");

  if (digest(input.target) !== input.targetSha256 || digest(retained) !== input.baselineSha256) {
    return yield* Effect.fail(
      Error("Archived fleet physical identity or retained baseline differs")
    );
  }

  const transition: Transition = (current) =>
    physicalErasure({ before, current, subject: input.target });

  const initialState = transition(initial);
  let state: "empty" | "absent";
  let session = Option.none<Member>();

  if (Option.isSome(initialState)) {
    state = initialState.value;
  } else {
    session = yield* eraseEstablished(input, transition);
    state = yield* observePhysicalCensus(
      { ...input, renew: input.renewCleanup },
      "waiting-physical-erasure",
      transition
    );
  }

  yield* input.record({
    stage: "physically-erased",
    state,
    physicalObject: input.target,
  });

  if (Option.isSome(session)) {
    yield* session.value.denied().pipe(Effect.timeout("1 minute"));
    yield* input.record({ stage: "continuation-session-denied" });
  }

  yield* input.budget("refusal");
  yield* input.refused().pipe(Effect.timeout("12 minutes"));
  const final = yield* input.inventory();

  if (Option.isNone(yield* Effect.try(() => transition(final)))) {
    return yield* Effect.fail(Error("Archived fleet User regained physical storage"));
  }

  yield* input.record({ stage: "physical-rechecked" });
});
