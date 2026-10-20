import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { Effect } from "effect";
import { CanonicalAdmissionUnavailable } from "./contract";

const retentionBatchSize = 1024;
const acceptanceLifetimeMs = 8_035_200_000;
const refilledBucketIdleMs = 60_000;

/** Expire response bodies at their replay deadline and obsolete admission metadata independently of caller activity. Each tick is bounded; live claims and unrefilled request buckets survive. */
export const sweepCanonicalAdmission = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<
  void,
  CanonicalAdmissionUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(
            `DELETE FROM canonical_request_replays WHERE (user_id,retry_key_digest) IN (SELECT user_id,retry_key_digest FROM canonical_request_replays WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ${retentionBatchSize})`
          )
          .bind(current),
        db
          .prepare(
            `DELETE FROM audit_entries WHERE record_type='request_admission' AND id IN (SELECT id FROM audit_entries WHERE record_type='request_admission' AND accepted_at_ms <= ? ORDER BY accepted_at_ms LIMIT ${retentionBatchSize})`
          )
          .bind(current - acceptanceLifetimeMs),
        db
          .prepare(
            `DELETE FROM canonical_request_buckets WHERE subject IN (SELECT subject FROM canonical_request_buckets WHERE virtual_at_ms <= ? ORDER BY virtual_at_ms LIMIT ${retentionBatchSize})`
          )
          .bind(current - refilledBucketIdleMs),
        db
          .prepare(
            `DELETE FROM canonical_request_leases WHERE id IN (SELECT id FROM canonical_request_leases WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ${retentionBatchSize})`
          )
          .bind(current),
      ]),
    catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
  }).pipe(Effect.asVoid);

export const makeCanonicalAdmissionErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
