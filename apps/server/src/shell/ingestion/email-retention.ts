import { Config, type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";

const minimumEmailIngestRetentionDays = 1;
const maximumEmailIngestRetentionDays = 90;

/** Production defaults to 90 days; bounded overrides keep retention tests deterministic. */
export const emailIngestRetentionDays = Config.schema(
  Schema.Int.check(
    Schema.isBetween({
      minimum: minimumEmailIngestRetentionDays,
      maximum: maximumEmailIngestRetentionDays,
    })
  ),
  "EMAIL_INGEST_RETENTION_DAYS"
).pipe(Config.withDefault(maximumEmailIngestRetentionDays));

/** Expires due raw samples, temporary interpretations, and visible review evidence atomically. */
export const runEmailIngestRetention = Effect.fn("runEmailIngestRetention")(function* (
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.DateTimeUtc,
    Result: Schema.Struct({ removed: Schema.Int }),
    execute: (cutoff) => sql`
      SELECT fidy_expire_email_ingest_samples(${cutoff}) AS removed
    `,
  })(now).pipe(
    Effect.map((row) => row.removed),
    Effect.orDie
  );
});
