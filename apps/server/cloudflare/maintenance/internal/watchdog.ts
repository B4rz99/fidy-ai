import { watchdogCoverage } from "./coverage";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Predicate, Schema } from "effect";
import { directoryName } from "../../directory/contract";
import { erasureRegistryName } from "../../erasure/contract";
import type { SharedBindings } from "../../storage-bootstrap/contract";
import { pricingName } from "../../subscription/contract";
import { completedCheckStatus, ownerCheckUrl } from "../contract";

const pageSize = 32;

const maximumUsers = 256;

const concurrency = 5;

const minuteMs = 60_000;

const tickMs = 55_000;

const probeMs = 1_000;

const cleanupMs = 100;

type Target = Readonly<{
  binding: SharedBindings[keyof SharedBindings];
  name: string;
  family: "directory" | "pricing" | "erasure" | "user";
  sampleWork: boolean;
}>;

type Outcome = "observed" | "repaired" | "failed" | "unsupported" | "unknown";

const unsupportedStatus = 404;

const Sample = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  release: Schema.String.check(Schema.isUUID()),
  band: Schema.Literals(["normal", "warning", "restricted"]),
  uncertain: Schema.NullOr(Schema.Int),
});

type Probe = Readonly<{
  outcome: Outcome;
  unsettled: boolean;
  sample: Option.Option<typeof Sample.Type>;
}>;

const sampleFrom = (response: Response): Option.Option<typeof Sample.Type> => {
  if (response.status !== completedCheckStatus) return Option.none();
  const uncertain = response.headers.get("fidy-uncertain-sample-count");

  return Schema.decodeUnknownOption(Sample)({
    version: Number(response.headers.get("fidy-schema-version")),
    release: response.headers.get("fidy-schema-release"),
    band: response.headers.get("fidy-storage-band"),
    uncertain: uncertain === null ? null : Number(uncertain),
  });
};

const inspect = (response: Response): Promise<Outcome> => {
  if (response.body !== null) {
    return response.body
      .cancel()
      .then(() => (response.status === unsupportedStatus ? "unsupported" : "failed"));
  }

  if (response.status === unsupportedStatus) return Promise.resolve("unsupported");
  const repair = response.headers.get("fidy-alarm-repaired");

  if (response.status !== completedCheckStatus || (repair !== "0" && repair !== "1")) {
    return Promise.resolve("failed");
  }

  return Promise.resolve(repair === "1" ? "repaired" : "observed");
};

const probe = Effect.fnUntraced(function* (target: Target, pending: Set<Promise<unknown>>) {
  if (target.binding === undefined) {
    return {
      outcome: "failed",
      unsettled: false,
      sample: Option.none<typeof Sample.Type>(),
    } satisfies Probe;
  }

  const binding = target.binding;
  let sample = Option.none<typeof Sample.Type>();
  const started = yield* Clock.currentTimeMillis;

  const { result, observed } = yield* Effect.scoped(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;

      const work = Promise.resolve()
        .then(() =>
          binding
            .getByName(target.name)
            .fetch(
              ownerCheckUrl,
              target.sampleWork === true
                ? { method: "POST", signal, headers: { "fidy-workflow-sample": "1" } }
                : { method: "POST", signal }
            )
        )
        .then((response) => {
          sample = sampleFrom(response);

          return inspect(response);
        })
        .catch((): Outcome => "unknown");

      pending.add(work);

      const released = work.finally(() => {
        pending.delete(work);
      });

      const result = Effect.tryPromise(() => released).pipe(Effect.orDie);
      const observed = yield* result.pipe(Effect.timeoutOption(probeMs - cleanupMs));

      return { result, observed };
    })
  );

  if (Option.isSome(observed)) return { outcome: observed.value, unsettled: false, sample };

  const remaining = Math.max(0, started + probeMs - (yield* Clock.currentTimeMillis));
  const settled = yield* result.pipe(Effect.timeoutOption(remaining));

  return {
    outcome: "unknown",
    unsettled: Option.isNone(settled),
    sample: Option.none<typeof Sample.Type>(),
  } satisfies Probe;
});

const Window = Schema.Struct({
  cursor: Schema.String,
  last_user: Schema.String,
  sample_user: Schema.String,
  defer_fixed: Schema.Int,
});

const Entry = Schema.Struct({ user_id: Schema.String });

const fixedTargets = (bindings: SharedBindings): Target[] => [
  { binding: bindings.DIRECTORY, name: directoryName, family: "directory", sampleWork: false },
  { binding: bindings.PRICING, name: pricingName, family: "pricing", sampleWork: false },
  { binding: bindings.ERASURE, name: erasureRegistryName, family: "erasure", sampleWork: false },
];

const familyAt = (batch: ReadonlyArray<Target>, index: number): string =>
  batch[index]?.family ?? "unknown";

const reportSamples = Effect.fnUntraced(function* (
  batch: ReadonlyArray<Target>,
  replies: ReadonlyArray<Probe>
) {
  const inspected = new Map<
    string,
    {
      owner: string;
      version: number;
      release: string;
      band: string;
      stores: number;
      measuredUncertainty: number;
      uncertain: number;
    }
  >();

  for (const [index, reply] of replies.entries()) {
    if (Option.isNone(reply.sample)) continue;
    const sample = reply.sample.value;
    const owner = familyAt(batch, index);
    const key = [owner, sample.version, sample.release, sample.band].join("/");

    const group = inspected.get(key) ?? {
      owner,
      version: sample.version,
      release: sample.release,
      band: sample.band,
      stores: 0,
      measuredUncertainty: 0,
      uncertain: 0,
    };

    group.stores++;

    if (sample.uncertain !== null) {
      group.uncertain += sample.uncertain;
      group.measuredUncertainty++;
    }

    inspected.set(key, group);
  }

  yield* Effect.forEach(
    inspected.values(),
    (group) => {
      const severity = { normal: "none", warning: "warning", restricted: "critical" }[group.band];

      return Effect.logInfo({
        ...group,
        uncertain: group.measuredUncertainty > 0 ? group.uncertain : null,
        message: `fidy.operational component=sqlite operation=${group.owner} state=${group.band} severity=${severity}`,
      });
    },
    { discard: true }
  );
});

const saveUserObservations = Effect.fnUntraced(function* (
  batch: ReadonlyArray<Target>,
  replies: ReadonlyArray<Probe>,
  now: number
) {
  const sql = yield* SqliteClient;

  const successfulUsers = batch.flatMap((target, index) =>
    target.family === "user" && Option.isSome(replies[index]?.sample ?? Option.none())
      ? [target.name]
      : []
  );

  if (successfulUsers.length > 0) {
    const ids = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
      successfulUsers
    );

    yield* sql`UPDATE lifetime_registry SET observed_ms=${now} WHERE user_id IN (SELECT value FROM json_each(${ids})) AND retired=0`;
  }
});

const reportShared = Effect.fnUntraced(function* (
  batch: ReadonlyArray<Target>,
  replies: ReadonlyArray<Probe>
) {
  return yield* Effect.reduce(
    batch.entries(),
    () => 0,
    (shared, [index, target]) => {
      const reply = replies[index];

      if (target.family === "user" || reply === undefined) return Effect.succeed(shared);
      const outcome = reply.outcome;

      const severity =
        ["observed", "repaired"].includes(outcome) && Option.isSome(reply.sample)
          ? "none"
          : "critical";

      return Effect.logInfo({
        message: `fidy.operational component=watchdog operation=${target.family} state=${outcome} severity=${severity}`,
        component: "watchdog",
        owner: target.family,
        outcome,
      }).pipe(Effect.as(Option.isSome(reply.sample) ? shared + 1 : shared));
    }
  );
});

const inspectBatch = Effect.fnUntraced(function* (
  cursor: Option.Option<string>,
  batch: ReadonlyArray<Target>,
  pending: Set<Promise<unknown>>
) {
  const sql = yield* SqliteClient;
  const containsShared = batch.some((target) => target.family !== "user");
  yield* sql`UPDATE watchdog_progress SET cursor=coalesce(${Option.getOrNull(cursor)},cursor),defer_fixed=coalesce(${containsShared ? 1 : null},defer_fixed),admitted=admitted+${batch.length},unknown=unknown+${batch.length} WHERE singleton=1`;
  const selected = batch.find((target) => target.sampleWork === true);

  if (selected !== undefined) {
    yield* sql`UPDATE watchdog_progress SET sample_cursor=${selected.name} WHERE singleton=1`;
  }

  const replies = yield* Effect.forEach(batch, (target) => probe(target, pending), { concurrency });
  const repaired = replies.filter(({ outcome }) => outcome === "repaired").length;
  const observed = replies.filter(({ outcome }) => outcome === "observed").length + repaired;
  const failed = replies.filter(({ outcome }) => outcome === "failed").length;
  const unsupported = replies.filter(({ outcome }) => outcome === "unsupported").length;
  const unsettled = replies.some((reply) => reply.unsettled);

  const sharedStalled = replies.some(
    (reply, index) => reply.unsettled && batch[index]?.family !== "user"
  );

  const updatePriority = unsettled || containsShared;
  const nextPriority = updatePriority ? Number(sharedStalled) : null;
  const attempted = batch.filter((target) => target.binding !== undefined).length;
  yield* reportSamples(batch, replies);
  const now = yield* Clock.currentTimeMillis;
  yield* saveUserObservations(batch, replies, now);
  const shared = yield* reportShared(batch, replies);
  yield* sql`UPDATE watchdog_progress SET shared_observed=shared_observed+${shared},last_attempt_ms=CASE WHEN ${attempted}>0 THEN ${now} ELSE last_attempt_ms END,last_observed_ms=CASE WHEN ${observed}>0 THEN ${now} ELSE last_observed_ms END,attempted=attempted+${attempted}, observed=observed+${observed},
        failed=failed+${failed}, unsupported=unsupported+${unsupported}, unknown=unknown-${observed + failed + unsupported},
        repaired=repaired+${repaired}, defer_fixed=coalesce(${nextPriority},defer_fixed) WHERE singleton=1`;

  return unsettled;
});

const inspectPage = Effect.fnUntraced(function* ({
  targets,
  startCursor,
  deadline,
  pending,
}: Readonly<{
  targets: ReadonlyArray<Target>;
  startCursor: string;
  deadline: number;
  pending: Set<Promise<unknown>>;
}>) {
  const probeFrom = (
    offset: number,
    cursor: string
  ): Effect.Effect<
    "deadline" | "cleanup" | { cursor: string },
    Effect.Error<ReturnType<typeof inspectBatch>>,
    Effect.Services<ReturnType<typeof inspectBatch>>
  > =>
    offset >= targets.length
      ? Effect.succeed({ cursor })
      : Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) + probeMs > deadline) return "deadline" as const;
          const batch = targets.slice(offset, offset + concurrency);
          const last = batch.at(-1);
          const checkpoint = last?.family === "user" ? Option.some(last.name) : Option.none();
          const nextCursor = Option.getOrElse(checkpoint, () => cursor);

          if (yield* inspectBatch(checkpoint, batch, pending)) {
            return "cleanup" as const;
          }

          return yield* probeFrom(offset + concurrency, nextCursor);
        });

  return yield* probeFrom(0, startCursor);
});

const scanUsers = Effect.fnUntraced(function* ({
  bindings,
  window,
  shared,
  dueBefore,
  deadline,
  pending,
}: Readonly<{
  bindings: SharedBindings;
  window: typeof Window.Type;
  shared: Target[];
  dueBefore: number;
  deadline: number;
  pending: Set<Promise<unknown>>;
}>) {
  const sql = yield* SqliteClient;
  let cursor = window.cursor;
  let remaining = maximumUsers;

  while (remaining > 0) {
    const limit = Math.min(pageSize, remaining);

    const page = yield* Schema.decodeUnknownEffect(Schema.Array(Entry))(
      yield* sql`SELECT user_id FROM lifetime_registry WHERE retired=0 AND (observed_ms=0 OR observed_ms<${dueBefore}) AND user_id>${cursor} AND user_id<=${window.last_user}
        ORDER BY user_id LIMIT ${limit}`
    );

    const targets = [
      ...shared.splice(0),
      ...page.map(({ user_id }) => ({
        binding: bindings.USER_STORE,
        name: user_id,
        sampleWork: user_id === window.sample_user,
        family: "user" as const,
      })),
    ];

    const next = yield* inspectPage({
      targets,
      startCursor: cursor,
      deadline,
      pending,
    });

    if (Predicate.isString(next)) return next;
    cursor = next.cursor;
    remaining -= page.length;

    if (remaining === maximumUsers && cursor === "" && window.last_user !== "") {
      return "recent" as const;
    }

    if (page.length < limit || cursor === window.last_user) {
      const wrapped = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE watchdog_progress SET cursor='',wraps=wraps+1,wrapped_at=${wrapped} WHERE singleton=1`;

      return "wrapped" as const;
    }
  }

  return "capacity" as const;
});

export const runWatchdog = Effect.fn(function* (
  bindings: SharedBindings,
  scheduled: number,
  pending: Set<Promise<unknown>>
) {
  const sql = yield* SqliteClient;
  const started = yield* Clock.currentTimeMillis;
  const minute = Math.floor(started / minuteMs);
  const dueBefore = scheduled - minuteMs;

  const claimed =
    yield* sql`UPDATE watchdog_progress SET minute=${minute},scheduled=${scheduled},started_ms=CASE WHEN started_ms=0 THEN ${started} ELSE started_ms END,halt='running',
    shared_observed=0,admitted=0,attempted=0,observed=0,failed=0,unsupported=0,unknown=0,repaired=0
    WHERE singleton=1 AND minute<${minute} AND scheduled<${scheduled}
    RETURNING cursor,defer_fixed,coalesce((SELECT max(user_id) FROM lifetime_registry WHERE retired=0),'') AS last_user,
      coalesce((SELECT user_id FROM lifetime_registry WHERE retired=0 AND (observed_ms=0 OR observed_ms<${dueBefore}) AND user_id>watchdog_progress.sample_cursor ORDER BY user_id LIMIT 1),
        (SELECT user_id FROM lifetime_registry WHERE retired=0 AND (observed_ms=0 OR observed_ms<${dueBefore}) ORDER BY user_id LIMIT 1),'') AS sample_user`;

  if (claimed.length === 0) return "coalesced" as const;
  const [window] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Window]))(claimed);
  const shared = fixedTargets(bindings);
  const deadline = started + tickMs;
  const defer = window.defer_fixed === 1;

  const halt = yield* scanUsers({
    bindings,
    window,
    shared: defer ? [] : shared,
    dueBefore,
    deadline: defer ? deadline - probeMs - cleanupMs : deadline,
    pending,
  });

  if (!defer || halt === "cleanup") return halt;

  const fixed = yield* inspectPage({
    targets: shared,
    startCursor: window.cursor,
    deadline,
    pending,
  });

  return Predicate.isString(fixed) ? fixed : halt;
});

export const reportWatchdog = Effect.fnUntraced(function* (
  halt: Effect.Success<ReturnType<typeof runWatchdog>>,
  nativeCoverage: boolean
) {
  if (halt === "coalesced") return;
  const sql = yield* SqliteClient;

  const [counts] =
    yield* sql`UPDATE watchdog_progress SET halt=${halt} WHERE singleton=1 RETURNING halt,admitted,attempted,observed,failed,unsupported,unknown,repaired,wraps,wrapped_at`;

  const coverage = yield* watchdogCoverage;

  if (nativeCoverage && halt === "wrapped" && coverage.severity === "none") {
    const [observed] =
      yield* sql`SELECT 1 FROM watchdog_progress WHERE singleton=1 AND failed=0 AND unsupported=0 AND unknown=0 AND shared_observed=3 AND NOT EXISTS(SELECT 1 FROM lifetime_registry WHERE retired=0 AND observed_ms=0)`;

    if (observed !== undefined) {
      yield* Effect.logInfo({
        message:
          "fidy.operational component=inspection-coverage operation=ownerInspections state=complete",
      });
    }
  }

  yield* Effect.logInfo({
    component: "watchdog",
    ...counts,
    ...coverage,
    message: `fidy.operational component=watchdog operation=coverage state=${halt} severity=${coverage.severity}`,
  });
});
