import { Clock, Config, Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { type FleetOrdinal, type TenState, fleetOrdinals, runTenFleet } from "./native-ten-fleet";
import type { FleetPilotBrowser } from "./native-fleet-pilot";
import type { UserObjects } from "./native-erasure-evidence";
import type { ErasureProgress } from "./native-erasure-continuation";

type Phase =
  | "ten-begin"
  | "ten-resume"
  | "ten-signup"
  | "ten-objects"
  | "ten-cleanup"
  | "ten-check"
  | "ten-logs";

type Browser = FleetPilotBrowser & {
  read: () => Effect.Effect<void, Error>;
  beginRefusal: (record: ErasureProgress) => Effect.Effect<Effect.Effect<void, Error>, Error>;
};

type Release = {
  revision: string;
  verifierRevision: string;
  coreVersion: string;
  publicVersion: string;
  userNamespace: string;
  path: string;
  survivors: () => Effect.Effect<ReadonlyArray<string>, Error>;
  inventory: () => Effect.Effect<UserObjects, Error>;
  browser: (ordinal: FleetOrdinal) => Browser;
  meter: (phase: Phase, ...args: string[]) => Effect.Effect<string, Error>;
  settle: () => Effect.Effect<void, Error>;
};

const maximumInventory = 36,
  activeOrdinal = 11,
  observationMs = 600_000;

const objectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const user = Schema.String.check(Schema.isUUID());

const ordinal = Schema.Literals(fleetOrdinals);

const Mapping = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: objectId, name: user })));

const Store = Schema.Struct({
  at: Schema.Int,
  baseline: Schema.Array(Schema.Tuple([objectId, Schema.Boolean])),
  survivors: Schema.Tuple([user, user]),
  members: Schema.Array(
    Schema.Struct({
      ordinal,
      user: Schema.Union([user, Schema.Literal("")]),
      physical: Schema.Union([objectId, Schema.Literal("")]),
    })
  ),
  events: Schema.Array(
    Schema.Struct({
      stage: Schema.String,
      at: Schema.Int,
      ordinal: Schema.optional(ordinal),
      reference: Schema.optional(Schema.String),
    })
  ),
});

type Source = { sourceRun: string; sourceVerifierRevision: string };

const persist = Effect.fn(function* (release: Release, source: Source, state: TenState) {
  const fs = yield* FileSystem.FileSystem;
  const { revision, verifierRevision, coreVersion, publicVersion, userNamespace, path } = release;

  const data = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    requestedPilotUsers: 10,
    revision,
    verifierRevision,
    coreVersion,
    publicVersion,
    userNamespace,
    ...source,
    ...state,
  });

  yield* fs.writeFileString(path + ".next", data);
  yield* fs.rename(path + ".next", path);
});

export const prepareTen = Effect.fn(function* (release: Release) {
  const survivors = yield* release.survivors();
  const rows = yield* release.inventory();

  if (
    new Set(survivors).size !== 2 ||
    [...rows.values()].filter(Boolean).length !== 3 ||
    rows.size >= maximumInventory
  ) {
    return yield* Effect.fail(
      Error("Expected the protected pre-fleet physical census and two stable Users")
    );
  }

  yield* persist(
    release,
    {
      sourceRun: yield* Config.String("GITHUB_RUN_ID"),
      sourceVerifierRevision: release.verifierRevision,
    },
    {
      at: yield* Clock.currentTimeMillis,
      baseline: [...rows],
      survivors: [...survivors],
      members: [],
      events: [],
    }
  );
});

const restore = Effect.fn(function* (release: Release, source: Source) {
  const fs = yield* FileSystem.FileSystem;

  const saved = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        ...Store.fields,
        revision: Schema.Literal(release.revision),
        verifierRevision: Schema.Literal(source.sourceVerifierRevision),
        sourceRun: Schema.Literal(source.sourceRun),
        sourceVerifierRevision: Schema.Literal(source.sourceVerifierRevision),
        coreVersion: Schema.Literal(release.coreVersion),
        publicVersion: Schema.Literal(release.publicVersion),
        userNamespace: Schema.Literal(release.userNamespace),
        requestedPilotUsers: Schema.Literal(fleetOrdinals.length),
      })
    )
  )(yield* fs.stream(release.path).pipe(Stream.decodeText(), Stream.mkString));

  if (
    saved.members.some((item, index) => item.ordinal !== fleetOrdinals[index]) ||
    new Map(saved.baseline).size !== saved.baseline.length ||
    new Set(saved.survivors).size !== 2
  ) {
    return yield* Effect.fail(Error("Archived fleet admission does not match the fixed cohort"));
  }

  const state: TenState = {
    at: saved.at,
    baseline: saved.baseline.map(([id, stored]) => [id, stored]),
    survivors: [...saved.survivors],
    members: saved.members.map((item) => ({ ...item })),
    events: saved.events.map(({ stage, at, ordinal, reference }) => ({
      stage,
      at,
      ...(ordinal === undefined ? {} : { ordinal }),
      ...(reference === undefined ? {} : { reference }),
    })),
  };

  return state;
});

const holdWindows = Effect.fn(function* (
  release: Release,
  browser: Browser,
  tick: () => Effect.Effect<void, Error>
) {
  const started = yield* Clock.currentTimeMillis;

  while ((yield* Clock.currentTimeMillis) - started < observationMs) {
    yield* release.meter("ten-check");
    yield* browser.renew();
    yield* browser.read();
    yield* tick();
    yield* Effect.sleep("25 seconds");
  }
});

const pacedBrowser = (): (<A>(flow: Effect.Effect<A, Error>) => Effect.Effect<A, Error>) => {
  let nextStart = 0;
  const cooldownMs = 12_000;

  return Effect.fn(function* <A>(flow: Effect.Effect<A, Error>) {
    yield* Effect.sleep(Math.max(0, nextStart - (yield* Clock.currentTimeMillis)));

    return yield* flow.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          nextStart = (yield* Clock.currentTimeMillis) + cooldownMs;
        })
      )
    );
  });
};

const admitNext = Effect.fn(function* (release: Release, ordinal: FleetOrdinal) {
  const status = yield* release.meter("ten-signup", String(ordinal)).pipe(
    Effect.map((output) => output.trim()),
    Effect.repeat({
      while: (value) => value === "pending",
      schedule: Schedule.spaced("15 seconds"),
    }),
    Effect.timeout("4 minutes")
  );

  if (status !== "admitted") {
    return yield* Effect.fail(Error("Next fleet enrollment is not admitted"));
  }
});

const tenSource = Effect.fn(function* (continued: boolean, release: Release) {
  return continued
    ? {
        sourceRun: yield* Config.String("FLEET_SOURCE_RUN"),
        sourceVerifierRevision: yield* Config.String("FLEET_SOURCE_REVISION"),
      }
    : {
        sourceRun: yield* Config.String("GITHUB_RUN_ID"),
        sourceVerifierRevision: release.verifierRevision,
      };
});

export const executeTen = Effect.fn(function* (release: Release, continued: boolean) {
  const source = yield* tenSource(continued, release);
  const state = yield* restore(release, source);

  if (continued && state.members.length === 0) {
    for (const ordinal of fleetOrdinals) state.members.push({ ordinal, user: "", physical: "" });
  }

  const fs = yield* FileSystem.FileSystem;

  const save = (): Effect.Effect<void, Error> =>
    persist(release, source, state).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  yield* save();

  const journal = Effect.fn(function* (stage: string, member: FleetOrdinal) {
    state.events.push({ stage, ordinal: member, at: yield* Clock.currentTimeMillis });
    yield* save();
  });

  const active = release.browser(activeOrdinal);
  const paced = pacedBrowser();

  const browser = (id: FleetOrdinal): Browser =>
    id === activeOrdinal ? active : release.browser(id);

  const work = yield* Effect.exit(
    runTenFleet(
      state,
      {
        save,
        inventory: release.inventory,
        survivors: release.survivors,
        objects: () =>
          release
            .meter("ten-objects", release.userNamespace, String(state.at))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Mapping))),
        beforeSignup: (ordinal) => admitNext(release, ordinal),
        renewCleanup: () => release.meter("ten-cleanup").pipe(Effect.andThen(active.renew)),
        signup: (ordinal) => paced(browser(ordinal).register()),
        login: (ordinal) => paced(browser(ordinal).login()),
        refused: (ordinal) =>
          release
            .meter("ten-cleanup")
            .pipe(
              Effect.andThen(() =>
                paced(browser(ordinal).beginRefusal((stage) => journal(stage, ordinal)))
              )
            ),
        watch: () => holdWindows(release, active, () => journal("foreground-read", activeOrdinal)),
      },
      continued ? "cleanup" : "measure"
    )
  );

  const logs = yield* Effect.exit(
    state.events.some((event) => event.stage === "observation-end")
      ? release.meter("ten-logs")
      : Effect.void
  );

  yield* release.settle();

  if (work._tag === "Failure") return yield* Effect.failCause(work.cause);

  if (logs._tag === "Failure") return yield* Effect.failCause(logs.cause);
});
