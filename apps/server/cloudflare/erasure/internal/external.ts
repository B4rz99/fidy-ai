import { ErasureProvider } from "../../../src/core/erasure/contract";
import { recoveryWindowMs } from "./retention-policy";
import { Clock, Effect } from "effect";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureExecution } from "../contract";

const expectedCustodians = ErasureProvider.literals.length;
const hourMilliseconds = 3600000;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
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
    const current = yield* Clock.currentTimeMillis;
    yield* io(() =>
      input.db
        .prepare(`UPDATE erasure_requests SET state='Complete'
    WHERE id=? AND user_id=? AND state='ExternalPending' AND marker_written=1 AND coordinator_cleared=1
    AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=erasure_requests.id)
    AND last_erased_at_ms+?<=?
    AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=erasure_requests.id AND delete_done=0)
    AND (SELECT count(*) FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=erasure_requests.id)=?
    AND NOT EXISTS(SELECT 1 FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=erasure_requests.id AND state NOT IN('Verified','NotApplicable'))`)
        .bind(
          input.scope.reference,
          input.scope.userId,
          recoveryWindowMs,
          current,
          expectedCustodians
        )
        .run()
    );
  });
