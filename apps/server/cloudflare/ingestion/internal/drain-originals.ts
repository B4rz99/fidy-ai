import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import type { LocalIngestionEnvironment } from "../contract";
import { reconcileOriginals } from "./original-writers";
import { inspectPublishedSamples, recoverSamples } from "./sample-publication";
import { releaseDueMedia } from "./local-media";
import { updateSharedCapacity } from "./email-capacity";

const pageSize = 8;

export const drainIngestion = Effect.fn(function* (user: UserId, env: LocalIngestionEnvironment) {
  const sql = yield* SqliteClient;
  yield* reconcileOriginals(user, env);
  const now = yield* Clock.currentTimeMillis;
  yield* releaseDueMedia(env.DIRECTORY, now, user);
  yield* inspectPublishedSamples(user, env, now);
  yield* recoverSamples(now, env);

  const rows =
    yield* sql`SELECT id,capacity_slot,capacity_generation FROM forwarded_email_receipts WHERE user_id=${user} AND capacity_slot IS NOT NULL AND NOT EXISTS(SELECT 1 FROM original_writers) AND NOT EXISTS(SELECT 1 FROM ingest_sample_reservations) LIMIT ${pageSize}`;

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (raw) {
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          id: Schema.String,
          capacity_slot: Schema.Int,
          capacity_generation: Schema.Int,
        })
      )(raw);

      yield* updateSharedCapacity(
        { directory: env.DIRECTORY, purpose: "email" },
        row.id,
        "Release"
      );
      yield* sql`UPDATE forwarded_email_receipts SET capacity_slot=NULL,capacity_generation=NULL,capacity_claimed=0 WHERE user_id=${user} AND id=${row.id} AND capacity_slot=${row.capacity_slot} AND capacity_generation=${row.capacity_generation}`;
    }),
    { discard: true }
  );
});
