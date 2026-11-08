import { Option, Schema } from "effect";
import type { RecoveryTiming } from "./protected-contract";

const decodeSql = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      timings: Schema.Struct({
        sql_duration_ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    })
  ).check(Schema.isMinLength(1))
);

const reportedSql = (rows: ReadonlyArray<D1Result<unknown>>): Option.Option<number> =>
  Option.map(decodeSql(rows.map((row) => row.meta)), (metadata) =>
    metadata.reduce((total, row) => total + row.timings.sql_duration_ms, 0)
  );

export type RecoveryMeasurement = Readonly<{
  generation: <A>(run: () => Promise<A>) => Promise<A>;
  database: <Row>(run: () => Promise<D1Result<Row>[]>) => Promise<D1Result<Row>[]>;
  respond: (response: Response) => Response;
  snapshot: () => RecoveryTiming;
  record: (timing: RecoveryTiming) => void;
  remote: <A>(run: () => Promise<A>) => Promise<A>;
}>;

const elapsed = <A>(run: () => Promise<A>, record: (duration: number) => void): Promise<A> => {
  const start = performance.now();
  try {
    return run().then(
      (value) => {
        record(performance.now() - start);
        return value;
      },
      (cause: unknown) => {
        record(performance.now() - start);
        throw cause;
      }
    );
  } catch (cause) {
    record(performance.now() - start);
    return Promise.reject(cause);
  }
};

type RecoveryDurations = {
  r2: number;
  d1: number;
  generations: number;
  batches: number;
  sql: Option.Option<number>;
  remote: number;
};

const appendTimings = (response: Response, measured: RecoveryDurations): Response => {
  if (measured.generations === 0) return response;
  const phases = {
    "recovery-r2": measured.r2,
    ...(measured.remote > 0 ? { "protected-remote": measured.remote } : {}),
    ...(measured.batches > 0 ? { "recovery-d1": measured.d1 } : {}),
    ...(measured.batches > 0 && Option.isSome(measured.sql)
      ? { "recovery-sql": measured.sql.value }
      : {}),
  };
  const headers = new Headers(response.headers);
  headers.set("fidy-recovery-batches", String(measured.batches));
  headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, duration]) => `${name};dur=${duration.toFixed(3)}`)
      .join(", ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const recordRemote = (measured: RecoveryDurations, timing: RecoveryTiming): void => {
  measured.r2 += timing.r2;
  measured.d1 += timing.d1;
  measured.generations += timing.generations;
  measured.batches += timing.batches;
  measured.sql =
    Option.isSome(measured.sql) && Option.isSome(timing.sql)
      ? Option.some(measured.sql.value + timing.sql.value)
      : Option.none();
};

/** Request-local measurements only. R2 includes generation body consumption; D1 includes its private assertion. */
export const makeRecoveryMeasurement = (): RecoveryMeasurement => {
  const measured: RecoveryDurations = {
    r2: 0,
    d1: 0,
    generations: 0,
    batches: 0,
    sql: Option.some(0),
    remote: 0,
  };
  const generation = <A>(run: () => Promise<A>): Promise<A> => {
    measured.generations += 1;
    return elapsed(run, (duration) => {
      measured.r2 += duration;
    });
  };
  const database = <Row>(run: () => Promise<D1Result<Row>[]>): Promise<D1Result<Row>[]> => {
    measured.batches += 1;
    return elapsed(run, (duration) => {
      measured.d1 += duration;
    }).then(
      (rows) => {
        const sql = reportedSql(rows);
        measured.sql =
          Option.isSome(measured.sql) && Option.isSome(sql)
            ? Option.some(measured.sql.value + sql.value)
            : Option.none();
        return rows;
      },
      (cause: unknown) => {
        measured.sql = Option.none();
        throw cause;
      }
    );
  };
  return {
    generation,
    database,
    respond: (response: Response): Response => appendTimings(response, measured),
    snapshot: () => ({
      r2: measured.r2,
      d1: measured.d1,
      generations: measured.generations,
      batches: measured.batches,
      sql: measured.sql,
    }),
    record: (timing) => recordRemote(measured, timing),
    remote: (run) =>
      elapsed(run, (duration) => {
        measured.remote += duration;
      }),
  };
};
