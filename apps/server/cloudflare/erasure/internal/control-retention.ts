import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration } from "../contract";

const maximumCases = 4;
const maximumObjects = 8;
const maximumRows = 64;
const Case = Schema.Struct({ reference: Schema.String, userId: Schema.String });
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const deleteControls = (
  input: ErasureRecoveryConfiguration & Readonly<{ scope: typeof Case.Type }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, bucket, scope } = input;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    for (const prefix of [`held/${scope.reference}/`, `held-records/${scope.reference}/`]) {
      const retained = yield* io(() => bucket.value.list({ prefix, limit: 1 }));
      if (retained.objects.length > 0) return yield* new ErasureUnavailable();
    }
    const locators = yield* io(() =>
      bucket.value.list({ prefix: `recovery/objects/${scope.reference}/`, limit: maximumObjects })
    );
    if (locators.objects.length > 0) {
      yield* io(() => bucket.value.delete(locators.objects.map((object) => object.key)));
      return;
    }
    yield* io(() => bucket.value.delete(`recovery/cases/${scope.reference}`));
    const children = [
      "erasure_steps",
      "erasure_archives",
      "erasure_permits",
      "erasure_chunk",
      "erasure_custody_evidence",
      "erasure_custody_events",
      "erasure_objects",
      "erasure_restore_members",
    ];
    yield* io(() =>
      db.batch([
        ...children.map((table) =>
          db
            .prepare(
              `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE request_id=? LIMIT ?)`
            )
            .bind(scope.reference, maximumRows)
        ),
        db
          .prepare(`DELETE FROM erasure_requests WHERE id=? AND user_id=? AND state='Complete'
      AND ${children.map((table) => `NOT EXISTS(SELECT 1 FROM ${table} WHERE request_id=erasure_requests.id)`).join(" AND ")}`)
          .bind(scope.reference, scope.userId),
      ])
    );
  });

/** Only completed cases past both approved control deadlines and the last personal-data backup window qualify. Failed or unresolved cases remain visible for operator review. */
export const purgeCompletedCases = (
  input: ErasureRecoveryConfiguration
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* io(() =>
      input.db
        .prepare(`SELECT id AS reference,user_id AS userId FROM erasure_requests
    WHERE state='Complete' AND json_extract(decision_json,'$.receiptRetention.untilMs')<=?
    AND json_extract(decision_json,'$.recovery.retention.untilMs')<=?
    AND last_erased_at_ms+json_extract(decision_json,'$.recovery.windowMs')<=?
    ORDER BY last_continued_at_ms,requested_at_ms LIMIT ?`)
        .bind(current, current, current, maximumCases)
        .all()
    );
    const cases = yield* Schema.decodeUnknownEffect(Schema.Array(Case))(rows.results);
    for (const scope of cases) {
      yield* io(() =>
        input.db
          .prepare(
            "UPDATE erasure_requests SET last_continued_at_ms=? WHERE id=? AND user_id=? AND state='Complete'"
          )
          .bind(current, scope.reference, scope.userId)
          .run()
      );
      yield* deleteControls({ ...input, scope });
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
