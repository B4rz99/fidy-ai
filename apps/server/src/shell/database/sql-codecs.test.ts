import * as PgTypes from "@effect/sql-pg/PgTypes";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EmailDeliveryIntentId } from "~/core/email-authentication/model";
import { ApiHarness } from "~/shell/testing/api-harness";

const NativeCodec = Schema.Struct({
  timestamp: Schema.DateTimeUtcFromDate,
  timestamptz: Schema.DateTimeUtcFromDate,
  date: Schema.String,
  int8: Schema.BigInt,
  bytes: Schema.Uint8Array,
  textArray: Schema.Array(Schema.String),
  uuidArray: Schema.Array(EmailDeliveryIntentId),
});

const EpochTimestampRequest = Schema.Struct({
  timestamp: Schema.Finite,
  timestamptz: Schema.Finite,
});

const TimestampRow = Schema.Struct({
  timestamp: Schema.DateTimeUtcFromDate,
  timestamptz: Schema.DateTimeUtcFromDate,
});

const SearchPathRow = Schema.Struct({ searchPath: Schema.String });

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
          const intentId = EmailDeliveryIntentId.make("019cfab8-7477-7000-8000-000000000001");
          const { row, epochRow } = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL TIME ZONE 'UTC'`;
              yield* sql`
                CREATE TEMPORARY TABLE sql_codec_probe (
                  timestamp_value timestamp NOT NULL,
                  timestamptz_value timestamptz NOT NULL,
                  date_value date NOT NULL,
                  int8_value bigint NOT NULL,
                  bytes_value bytea NOT NULL,
                  text_array_value text[] NOT NULL,
                  uuid_array_value uuid[] NOT NULL
                ) ON COMMIT DROP
              `;
              const row = yield* SqlSchema.findOne({
                Request: NativeCodec,
                Result: NativeCodec,
                execute: (request) => sql`
                  INSERT INTO sql_codec_probe (
                    timestamp_value, timestamptz_value, date_value,
                    int8_value, bytes_value, text_array_value, uuid_array_value
                  ) VALUES (
                    ${request.timestamp}, ${request.timestamptz}, ${request.date}::date,
                    ${request.int8}, ${request.bytes}, ${request.textArray}::text[],
                    ${request.uuidArray}::uuid[]
                  )
                  RETURNING timestamp_value AS "timestamp",
                    timestamptz_value AS "timestamptz",
                    date_value AS "date",
                    int8_value AS "int8",
                    bytes_value AS "bytes",
                    text_array_value AS "textArray",
                    uuid_array_value AS "uuidArray"
                `,
              })({
                timestamp: instant,
                timestamptz: instant,
                date: "2026-03-14",
                int8: 9_223_372_036_854_775_807n,
                bytes,
                textArray: ["read", "write", "dashboard"],
                uuidArray: [intentId],
              });
              const epochRow = yield* SqlSchema.findOne({
                Request: EpochTimestampRequest,
                Result: TimestampRow,
                execute: (request) => sql`
                  INSERT INTO sql_codec_probe (
                    timestamp_value, timestamptz_value, date_value,
                    int8_value, bytes_value, text_array_value, uuid_array_value
                  ) VALUES (
                    ${PgTypes.timestamp(request.timestamp)},
                    ${PgTypes.timestamptz(request.timestamptz)}, DATE '2026-03-14',
                    0, ''::bytea, '{}', '{}'
                  )
                  RETURNING timestamp_value AS "timestamp",
                    timestamptz_value AS "timestamptz"
                `,
              })({
                timestamp: DateTime.toEpochMillis(instant),
                timestamptz: DateTime.toEpochMillis(instant),
              });
              return { row, epochRow };
            })
          );

          expect(DateTime.toEpochMillis(row.timestamp)).toBe(DateTime.toEpochMillis(instant));
          expect(DateTime.toEpochMillis(row.timestamptz)).toBe(DateTime.toEpochMillis(instant));
          expect(row.date).toBe("2026-03-14");
          expect(row.int8).toBe(9_223_372_036_854_775_807n);
          expect(row.bytes).toEqual(bytes);
          expect(row.textArray).toEqual(["read", "write", "dashboard"]);
          expect(row.uuidArray).toEqual([intentId]);
          expect(DateTime.toEpochMillis(epochRow.timestamp)).toBe(DateTime.toEpochMillis(instant));
          expect(DateTime.toEpochMillis(epochRow.timestamptz)).toBe(
            DateTime.toEpochMillis(instant)
          );
        })
    );

    it.effect("applies the PostgreSQL options carried by the database URL", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const row = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: SearchPathRow,
          execute: () => sql`SELECT current_setting('search_path') AS "searchPath"`,
        })(undefined);

        expect(row.searchPath.split(",").map((schema) => schema.trim())).toEqual([
          "fidy_durable",
          "public",
        ]);
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
