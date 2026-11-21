import { Clock, Effect, Exit, Option, Schedule } from "effect";
import type { UserObjects } from "./native-erasure-evidence";
import type { FleetPilotBrowser } from "./native-fleet-pilot";

const firstOrdinal = 2,
  lastOrdinal = 11;

export const fleetOrdinals = Array.from(
  { length: lastOrdinal - firstOrdinal + 1 },
  (_, index) => firstOrdinal + index
);

export type FleetOrdinal = number;

type Browser = Effect.Success<ReturnType<FleetPilotBrowser["login"]>>;

type Event = { stage: string; at: number } & Readonly<Record<string, string | number>>;

type Member = { ordinal: FleetOrdinal; user: string; physical: string };

export type TenState = {
  at: number;
  baseline: Array<[string, boolean]>;
  survivors: string[];
  members: Member[];
  events: Event[];
};

export type TenFleetPort = {
  save: () => Effect.Effect<void, Error>;
  inventory: () => Effect.Effect<UserObjects, Error>;
  objects: () => Effect.Effect<ReadonlyArray<{ id: string; name: string }>, Error>;
  signup: (ordinal: FleetOrdinal) => Effect.Effect<Pick<Browser, "id" | "outcome">, Error>;
  login: (ordinal: FleetOrdinal) => Effect.Effect<Browser, Error>;
  refused: (ordinal: FleetOrdinal) => Effect.Effect<Effect.Effect<void, Error>, Error>;
  survivors: () => Effect.Effect<ReadonlyArray<string>, Error>;
  renewCleanup: () => Effect.Effect<void, Error>;
  beforeSignup: (ordinal: FleetOrdinal) => Effect.Effect<void, Error>;
  watch: () => Effect.Effect<void, Error>;
};

type Trial = { state: TenState; port: TenFleetPort };

const note = Effect.fn(function* (
  { state, port }: Trial,
  stage: string,
  detail: Readonly<Record<string, string | number>> = {}
) {
  state.events.push({ stage, at: yield* Clock.currentTimeMillis, ...detail });
  yield* port.save();
});

const unchanged = (state: TenState, rows: UserObjects): void => {
  if (state.baseline.some(([id, stored]) => rows.get(id) !== stored)) {
    throw Error("Previous physical fleet inventory changed");
  }
};

const assignUser = (state: TenState, member: Member, user: string): void => {
  if (
    state.survivors.includes(user) ||
    state.members.some((other) => other !== member && other.user === user)
  ) {
    throw Error("Fleet registration did not identify a distinct User");
  }

  if (member.user !== "" && member.user !== user) throw Error("Archived fleet User changed");
  member.user = user;
};

const enroll = Effect.fn(function* (trial: Trial) {
  const { state, port } = trial;

  if (state.members.length > 0) return yield* Effect.fail(Error("Fresh fleet admission required"));

  yield* Effect.forEach(
    fleetOrdinals,
    Effect.fnUntraced(function* (ordinal) {
      yield* port.beforeSignup(ordinal);
      const entry = { ordinal, user: "", physical: "" };
      state.members.push(entry);
      yield* note(trial, "signup-started", { ordinal });
      const browser = yield* port.signup(ordinal).pipe(Effect.timeout("2 minutes"));

      if (browser.outcome !== "created") {
        return yield* Effect.fail(Error("Fleet signup was not new"));
      }

      yield* Effect.try(() => assignUser(state, entry, browser.id));
      yield* note(trial, "signup-created", { ordinal });
    }),
    { discard: true }
  );
});

const census = Effect.fn(function* (trial: Trial, missing: ReadonlyArray<Member>) {
  const { state, port } = trial;
  const bindings = yield* port.objects();
  const current = yield* port.inventory();
  yield* Effect.try(() => unchanged(state, current));

  yield* Effect.forEach(
    missing.filter((item) => item.physical === ""),
    Effect.fnUntraced(function* (member) {
      const matches = bindings.filter((row) => row.name === member.user);

      if (matches.length > 1) {
        return yield* Effect.fail(Error("Ambiguous fleet physical identity"));
      }

      const [match] = matches;

      if (match === undefined) return;

      if (
        state.baseline.some(([id]) => id === match.id) ||
        state.members.some((item) => item.physical === match.id)
      ) {
        return yield* Effect.fail(Error("Fleet identity collides with retained physical storage"));
      }

      if (current.get(match.id) !== true) return;
      member.physical = match.id;
      yield* note(trial, "member-bound", { ordinal: member.ordinal });
    }),
    { discard: true }
  );

  return missing.every((item) => item.physical !== "");
});

const bind = Effect.fn(function* (trial: Trial) {
  const { state } = trial;
  const missing = state.members.filter((member) => member.user !== "" && member.physical === "");

  if (missing.length === 0) return;

  yield* census(trial, missing).pipe(
    Effect.repeat({ while: (done) => !done, schedule: Schedule.spaced("30 seconds") }),
    Effect.timeout("20 minutes")
  );
});

const measured = Effect.fn(function* (trial: Trial) {
  yield* enroll(trial);
  yield* bind(trial);
  const { state, port } = trial;
  const current = yield* port.inventory();
  yield* Effect.try(() => unchanged(state, current));

  if (
    current.size !== state.baseline.length + fleetOrdinals.length ||
    state.members.some((member) => current.get(member.physical) !== true)
  ) {
    return yield* Effect.fail(
      Error("All ten new physical Users must coexist with the prior inventory")
    );
  }

  yield* note(trial, "observation-start");
  yield* port.watch().pipe(Effect.timeout("12 minutes"));
  yield* note(trial, "observation-end");
});

const restoreIdentities = Effect.fn(function* (trial: Trial) {
  const { state, port } = trial;

  yield* Effect.forEach(
    state.members.filter((item) => item.user === ""),
    Effect.fnUntraced(function* (member) {
      const session = yield* port
        .login(member.ordinal)
        .pipe(Effect.timeout("2 minutes"), Effect.option);

      if (Option.isSome(session)) {
        if (session.value.outcome !== "approved") {
          return yield* Effect.fail(Error("Fleet login was not established"));
        }

        yield* Effect.try(() => assignUser(state, member, session.value.id));
        yield* note(trial, "signup-reconciled", { ordinal: member.ordinal });
      }
    }),
    { discard: true }
  );

  yield* bind(trial);
});

const retainedTarget = (state: TenState, entry: Member): boolean =>
  state.survivors.includes(entry.user) || state.baseline.some(([id]) => id === entry.physical);

const submit = Effect.fn(function* (trial: Trial, entry: Member) {
  const { state, port } = trial;

  if (entry.physical === "") return Option.none<Browser>();

  if (retainedTarget(state, entry)) {
    return yield* Effect.fail(Error("Fleet cleanup target is a retained owner"));
  }

  const rows = yield* port.inventory();
  yield* Effect.try(() => unchanged(state, rows));

  if (rows.get(entry.physical) !== true) return Option.none<Browser>();
  yield* port.renewCleanup();
  const session = yield* port.login(entry.ordinal).pipe(Effect.timeout("2 minutes"), Effect.option);

  if (Option.isNone(session)) return session;

  if (session.value.outcome !== "approved" || session.value.id !== entry.user) {
    return yield* Effect.fail(Error("Fresh login did not match the bound physical fleet User"));
  }

  yield* note(trial, "erasure-started", { ordinal: entry.ordinal });
  const result = yield* session.value.erase().pipe(Effect.timeout("2 minutes"), Effect.option);

  if (Option.isSome(result)) {
    yield* note(trial, "member-admitted", { ordinal: entry.ordinal, reference: result.value });
  } else yield* note(trial, "erasure-reply-unconfirmed", { ordinal: entry.ordinal });

  return session;
});

const disposed = Effect.fn(function* (trial: Trial, final: boolean) {
  const { state, port } = trial;
  const rows = yield* port.inventory();
  yield* Effect.try(() => unchanged(state, rows));

  const known = new Set([
    ...state.baseline.map(([id]) => id),
    ...state.members.map((item) => item.physical),
  ]);

  if (final && [...rows.keys()].some((id) => !known.has(id))) {
    return yield* Effect.fail(Error("Unidentified physical object during cohort cleanup"));
  }

  return state.members
    .filter((item) => item.physical !== "")
    .every((item) => rows.get(item.physical) !== true);
});

const disposeMembers = Effect.fn(function* (trial: Trial) {
  const { state, port } = trial;
  const sessions = yield* Effect.forEach(state.members, (entry) => submit(trial, entry));
  yield* Effect.suspend(() =>
    port.renewCleanup().pipe(Effect.andThen(disposed(trial, false)))
  ).pipe(
    Effect.repeat({
      while: (done) => !done,
      schedule: Schedule.spaced("30 seconds"),
    }),
    Effect.timeout("20 minutes")
  );

  yield* Effect.forEach(
    state.members.filter((item) => item.physical !== ""),
    (member) => note(trial, "member-erased", { ordinal: member.ordinal }),
    { discard: true }
  );

  yield* Effect.forEach(
    sessions.filter(Option.isSome),
    (session) => session.value.denied().pipe(Effect.timeout("1 minute")),
    { discard: true }
  );

  const expiry = yield* Effect.forEach(state.members, (member) => port.refused(member.ordinal));
  yield* Effect.all(expiry, { concurrency: 1, discard: true }).pipe(Effect.timeout("12 minutes"));
});

const cleanup = Effect.fn(function* (trial: Trial) {
  const { state, port } = trial;
  yield* port.renewCleanup();
  const restored = yield* Effect.exit(restoreIdentities(trial));
  const unresolved = state.members.filter((member) => member.physical === "" || member.user === "");

  yield* Effect.forEach(
    unresolved,
    (member) => note(trial, "member-unresolved", { ordinal: member.ordinal }),
    { discard: true }
  );

  yield* disposeMembers(trial);
  const survivors = yield* port.survivors();

  if (
    survivors.length !== 2 ||
    survivors.some((id, index) => id !== state.survivors[index]) ||
    !(yield* disposed(trial, true))
  ) {
    return yield* Effect.fail(Error("Original fleet survivors or physical erasure regressed"));
  }

  if (Exit.isFailure(restored)) return yield* Effect.failCause(restored.cause);

  if (unresolved.length > 0) {
    return yield* Effect.fail(Error("Fleet signup identity remains unresolved"));
  }

  yield* note(trial, "cleanup-verified");
});

export const runTenFleet = Effect.fn(function* (
  state: TenState,
  port: TenFleetPort,
  mode: "measure" | "cleanup"
) {
  const trial = { state, port };
  const observation = yield* Effect.exit(mode === "measure" ? measured(trial) : Effect.void);

  if (state.members.length > 0) yield* cleanup(trial);

  if (Exit.isFailure(observation)) return yield* Effect.failCause(observation.cause);
});
