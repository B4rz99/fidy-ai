import { Duration, Effect, Option, Schema } from "effect";

export type CanonicalRequestTimings = Record<"admission" | "owner" | "standing", number>;

/** Completed phases accumulate request-local elapsed time. Failed work remains in total/other; authority, queried content and identifiers never enter headers. */
export const measureCanonicalPhase = <A, E, R>({
  work,
  phase,
  timings,
}: Readonly<{
  work: Effect.Effect<A, E, R>;
  phase: keyof CanonicalRequestTimings;
  timings: Option.Option<CanonicalRequestTimings>;
}>): Effect.Effect<A, E, R> =>
  Option.isNone(timings)
    ? work
    : work.pipe(
        Effect.timed,
        Effect.map(([duration, value]) => {
          timings.value[phase] += Duration.toMillis(duration);
          return value;
        })
      );

/** Preserve streaming and all existing headers while exposing fixed, numeric diagnostic phases. */
export const appendCanonicalTimings = ({
  response,
  duration,
  timings,
}: Readonly<{
  response: Response;
  duration: Duration.Duration;
  timings: CanonicalRequestTimings;
}>): Response => {
  const total = Duration.toMillis(duration);
  const phases = {
    "canonical-total": total,
    "canonical-admission": timings.admission,
    "canonical-owner": timings.owner,
    "canonical-standing": timings.standing,
    "canonical-other": Math.max(0, total - timings.admission - timings.owner - timings.standing),
  };
  const headers = new Headers(response.headers);
  headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, elapsed]) => `${name};dur=${elapsed.toFixed(3)}`)
      .join(", ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export type CanonicalSnapshotTimings = {
  storage: number;
  presentation: number;
  sql: Option.Option<number>;
};

const decodeStatementTimings = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      timings: Schema.Struct({
        sql_duration_ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    })
  ).check(Schema.isMinLength(1))
);

/** Native statement execution, excluding transport; unavailable metadata is not a zero sample. */
export const reportedSqlDuration = (metadata: ReadonlyArray<unknown>): Option.Option<number> =>
  Option.map(decodeStatementTimings(metadata), (rows) =>
    rows.reduce((total, row) => total + row.timings.sql_duration_ms, 0)
  );

/** Snapshot protection only; outer ingress is excluded. SQL covers returned statements, not assertions privately owned by a storage wrapper. */
export const appendSnapshotTimings = ({
  response,
  duration,
  timings,
}: Readonly<{
  response: Response;
  duration: Duration.Duration;
  timings: CanonicalSnapshotTimings;
}>): Response => {
  const total = Duration.toMillis(duration);
  const phases = {
    "canonical-total": total,
    "canonical-storage": timings.storage,
    "canonical-present": timings.presentation,
    "canonical-other": Math.max(0, total - timings.storage - timings.presentation),
    ...(Option.isSome(timings.sql) ? { "canonical-sql": timings.sql.value } : {}),
  };
  const headers = new Headers(response.headers);
  headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, elapsed]) => `${name};dur=${elapsed.toFixed(3)}`)
      .join(", ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
