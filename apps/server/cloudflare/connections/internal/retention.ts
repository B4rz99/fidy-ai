import { Effect } from "effect";
import { ConnectionRetentionUnavailable } from "../contract";

const attemptRetentionMilliseconds = 86400000;
const maximumRetentionRows = 128;

/** Erase expired continuation metadata independently of User activity or current Consent. */
export const sweepAttempts = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db.batch([
        input.db
          .prepare(`UPDATE connection_authorizations SET phase='failed',verifier=NULL,handoff_url=NULL WHERE attempt_id IN
      (SELECT b.attempt_id FROM connection_authorizations b JOIN connection_attempts a ON a.id=b.attempt_id JOIN connections c ON c.id=a.connection_id
      WHERE a.expires_at_ms<=? AND b.phase!='failed' AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`UPDATE connection_grants SET state='cleanup_required' WHERE attempt_id IN(
          SELECT g.attempt_id FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id
          WHERE g.state IN ('claimed','quarantined') AND a.expires_at_ms<=?
          AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`UPDATE connections SET state='Action required' WHERE id IN(
          SELECT c.id FROM connections c JOIN connection_attempts a ON a.connection_id=c.id JOIN connection_grants g ON g.attempt_id=a.id
          WHERE c.state='Connecting' AND g.state='cleanup_required' AND a.expires_at_ms<=?
          AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid)
          AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`DELETE FROM connection_attempts WHERE id IN
      (SELECT a.id FROM connection_attempts a WHERE expires_at_ms <= ?
        AND NOT EXISTS(SELECT 1 FROM connection_authorizations b WHERE b.attempt_id=a.id AND b.consent_id IS NOT NULL)
        ORDER BY expires_at_ms, id LIMIT ?)`)
          .bind(input.current - attemptRetentionMilliseconds, maximumRetentionRows),
      ]),
    catch: () => new ConnectionRetentionUnavailable(),
  }).pipe(Effect.asVoid);
