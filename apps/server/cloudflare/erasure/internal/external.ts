import { purgeHeldRecords } from "./held-records";
import { Clock, Effect } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureScope } from "../../erasure-store/contract";
import type { ErasureExecution } from "../contract";

const maximumRows = 64;
const expectedCustodians = 8;
const hourMilliseconds = 3600000;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const purgeArchives = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const result = yield* io(() =>
      input.db.batch([
        input.db
          .prepare(`DELETE FROM erasure_archives WHERE (request_id,store_id,row_ref) IN (
      SELECT a.request_id,a.store_id,a.row_ref FROM erasure_archives a
      JOIN erasure_requests q ON q.id=a.request_id JOIN erasure_steps s ON s.request_id=a.request_id AND s.store_id=a.store_id
      WHERE q.id=? AND q.user_id=? AND q.state='ExternalPending'
      AND json_extract(q.decision_json,'$.dispositions.'||s.data_class||'.retention.untilMs')<=? LIMIT ?)`)
          .bind(input.scope.reference, input.scope.userId, current, maximumRows),
        input.db
          .prepare(
            "UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=? AND user_id=? AND changes()>0"
          )
          .bind(current, input.scope.reference, input.scope.userId),
        input.db
          .prepare(
            "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare' AND changes()>0"
          )
          .bind(input.scope.reference),
      ])
    );
    return result[0]?.meta.changes === 0;
  });
export const settleExternal = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const resumedAt = yield* Clock.currentTimeMillis;
    yield* io(() =>
      input.db
        .prepare(
          "UPDATE erasure_requests SET next_continuation_at_ms=? WHERE id=? AND user_id=? AND state='ExternalPending'"
        )
        .bind(resumedAt + hourMilliseconds, input.scope.reference, input.scope.userId)
        .run()
    );
    if (!(yield* purgeArchives(input)) || !(yield* input.originals.purge(input.scope))) return;
    if (!(yield* purgeHeldRecords({ configuration: input.recovery, scope: input.scope }))) return;
    yield* finalizePurge(input);
    const current = yield* Clock.currentTimeMillis;
    yield* io(() =>
      input.db
        .prepare(`UPDATE erasure_requests SET state='Complete'
    WHERE id=? AND user_id=? AND state='ExternalPending' AND marker_written=1 AND coordinator_cleared=1
    AND purge_pending=0 AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=erasure_requests.id)
    AND last_erased_at_ms+json_extract(decision_json,'$.recovery.windowMs')<=?
    AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=erasure_requests.id AND delete_done=0)
    AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE request_id=erasure_requests.id)
    AND NOT EXISTS(SELECT 1 FROM erasure_objects WHERE request_id=erasure_requests.id AND done=0)
    AND (SELECT count(*) FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=erasure_requests.id)=?
    AND NOT EXISTS(SELECT 1 FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=erasure_requests.id AND state NOT IN('Verified','NotApplicable'))`)
        .bind(input.scope.reference, input.scope.userId, current, expectedCustodians)
        .run()
    );
  });

const finalizePurge = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* io(() =>
      input.db.batch([
        input.db
          .prepare(
            "UPDATE erasure_requests SET purge_pending=0,last_erased_at_ms=? WHERE id=? AND user_id=? AND purge_pending=1 AND state='ExternalPending'"
          )
          .bind(current, input.scope.reference, input.scope.userId),
        input.db
          .prepare(
            "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare' AND changes()>0"
          )
          .bind(input.scope.reference),
      ])
    );
  });
