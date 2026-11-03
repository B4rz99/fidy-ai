import { Duration, Effect, Option } from "effect";
import { expect, it } from "vitest";
import { appendSnapshotTimings, reportedSqlDuration } from "./internal/response-timing";

it("reports native SQL execution separately from storage waiting and preserves the response", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = reportedSqlDuration([
        { timings: { sql_duration_ms: 0.125 }, query: "must not enter headers" },
        { timings: { sql_duration_ms: 0.25 }, params: ["must not enter headers"] },
      ]);
      expect(sql).toEqual(Option.some(0.375));
      const response = appendSnapshotTimings({
        response: new Response("complete response", {
          status: 202,
          headers: {
            "cache-control": "no-store",
            "fidy-canonical-remaining": "12",
            "server-timing": "upstream;dur=2",
          },
        }),
        duration: Duration.millis(20),
        timings: { storage: 15, presentation: 3, sql },
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("fidy-canonical-remaining")).toBe("12");
      expect(response.headers.get("server-timing")).toBe(
        "upstream;dur=2, canonical-total;dur=20.000, canonical-storage;dur=15.000, canonical-present;dur=3.000, canonical-other;dur=2.000, canonical-sql;dur=0.375"
      );
      expect(yield* Effect.tryPromise(() => response.text())).toBe("complete response");
    })
  ));

it.each([
  { metadata: [] },
  { metadata: [{}] },
  { metadata: [{ timings: {} }] },
  { metadata: [{ timings: { sql_duration_ms: -1 } }] },
  { metadata: [{ timings: { sql_duration_ms: Number.NaN } }] },
  { metadata: [{ timings: { sql_duration_ms: Number.POSITIVE_INFINITY } }] },
  { metadata: [{ timings: { sql_duration_ms: "0.25" } }] },
  { metadata: [{ timings: { sql_duration_ms: 0.25 } }, {}] },
])("does not invent SQL duration from incomplete or malformed metadata %j", ({ metadata }) => {
  expect(reportedSqlDuration(metadata)).toEqual(Option.none());
});

it("distinguishes an unavailable SQL measurement from a measured zero", () => {
  const make = (sql: Option.Option<number>): string =>
    Option.getOrThrow(
      Option.fromNullishOr(
        appendSnapshotTimings({
          response: new Response(null),
          duration: Duration.millis(2),
          timings: { storage: 1, presentation: 1, sql },
        }).headers.get("server-timing")
      )
    );
  expect(make(Option.none())).not.toContain("canonical-sql");
  expect(make(reportedSqlDuration([{ timings: { sql_duration_ms: 0 } }]))).toContain(
    "canonical-sql;dur=0.000"
  );
});
