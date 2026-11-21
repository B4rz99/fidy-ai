import { Duration, Option, Schema } from "effect";

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

export const reportedSqlDuration = (metadata: ReadonlyArray<unknown>): Option.Option<number> =>
  Option.map(decodeStatementTimings(metadata), (rows) =>
    rows.reduce((total, row) => total + row.timings.sql_duration_ms, 0)
  );

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

  const measured = {
    "canonical-total": total,
    "canonical-storage": timings.storage,
    "canonical-present": timings.presentation,
    "canonical-other": Math.max(0, total - timings.storage - timings.presentation),
  };

  const phases = Option.match(timings.sql, {
    onNone: () => measured,
    onSome: (sql) => ({ ...measured, "canonical-sql": sql }),
  });

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
