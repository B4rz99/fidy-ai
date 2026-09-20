import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ApiHarness } from "~/shell/testing/api-harness";

const NativeCodecRequest = Schema.Struct({
  timestamp: Schema.DateTimeUtcFromDate,
  timestamptz: Schema.DateTimeUtcFromDate,
  date: Schema.String,
  int8: Schema.BigInt,
  bytes: Schema.Uint8Array,
  textArray: Schema.Array(Schema.String),
});

const NativeCodecRow = Schema.Struct({
  timestamp: Schema.DateTimeUtcFromDate,
  timestamptz: Schema.DateTimeUtcFromDate,
  date: Schema.String,
  int8: Schema.BigInt,
  bytes: Schema.Uint8Array,
  textArray: Schema.Array(Schema.String),
});

const DatabaseTypeColumn = Schema.Struct({
  tableName: Schema.String,
  columnName: Schema.String,
  dataType: Schema.String,
  udtName: Schema.String,
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "native PostgreSQL codecs",
  (it) => {
    it.effect(
      "round-trips restored timestamp codecs and decodes changed scalar representations",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const instant = DateTime.makeUnsafe("2026-03-14T15:09:26.535Z");
          const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
          const row = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL TIME ZONE 'UTC'`;
              yield* sql`
              CREATE TEMPORARY TABLE sql_codec_probe (
                timestamp_value timestamp NOT NULL,
                timestamptz_value timestamptz NOT NULL,
                date_value date NOT NULL,
                int8_value bigint NOT NULL,
                bytes_value bytea NOT NULL,
                text_array_value text[] NOT NULL
              ) ON COMMIT DROP
            `;
              return yield* SqlSchema.findOne({
                Request: NativeCodecRequest,
                Result: NativeCodecRow,
                execute: (request) => sql`
                INSERT INTO sql_codec_probe (
                  timestamp_value, timestamptz_value, date_value,
                  int8_value, bytes_value, text_array_value
                ) VALUES (
                  ${request.timestamp}, ${request.timestamptz}, ${request.date}::date,
                  ${request.int8}, ${request.bytes}, ${request.textArray}::text[]
                )
                RETURNING timestamp_value AS "timestamp",
                  timestamptz_value AS "timestamptz",
                  date_value AS "date",
                  int8_value AS "int8",
                  bytes_value AS "bytes",
                  text_array_value AS "textArray"
              `,
              })({
                timestamp: instant,
                timestamptz: instant,
                date: "2026-03-14",
                int8: 9_223_372_036_854_775_807n,
                bytes,
                textArray: ["read", "write", "dashboard"],
              });
            })
          );

          expect(DateTime.toEpochMillis(row.timestamp)).toBe(DateTime.toEpochMillis(instant));
          expect(DateTime.toEpochMillis(row.timestamptz)).toBe(DateTime.toEpochMillis(instant));
          expect(row.date).toBe("2026-03-14");
          expect(row.int8).toBe(9_223_372_036_854_775_807n);
          expect(row.bytes).toEqual(bytes);
          expect(row.textArray).toEqual(["read", "write", "dashboard"]);
        })
    );

    it.effect("keeps every Fidy enum and array column on registered native representations", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const columns = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: DatabaseTypeColumn,
          execute: () => sql`
            SELECT table_name AS "tableName", column_name AS "columnName",
              data_type AS "dataType", udt_name AS "udtName"
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (data_type = 'ARRAY' OR data_type = 'USER-DEFINED')
            ORDER BY table_name, ordinal_position
          `,
        })(undefined);

        expect(columns.length).toBeGreaterThan(0);
        expect(
          columns.every((column) => column.dataType === "ARRAY" && column.udtName === "_text")
        ).toBe(true);
      })
    );
  }
);
