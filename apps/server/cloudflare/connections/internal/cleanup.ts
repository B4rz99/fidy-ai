import { Clock, Effect, Option, type Redacted, Schema } from "effect";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankCleanup,
  ConnectionRetentionUnavailable,
} from "../contract";
import { transactionId } from "../../canonical-work/operations";
import { grantPurpose, openGrant } from "./grant";

const maximumEnvelopeLength = 100000;
const leaseMilliseconds = 120000;
const retryMilliseconds = 300000;
const Candidate = Schema.Struct({
  attemptId: Schema.String,
  connectionId: Schema.String,
  userId: Schema.String,
  consentId: Schema.String,
  intentJson: Schema.String,
  accessSeen: Schema.Literals([0, 1]),
  refreshSeen: Schema.Literals([0, 1]),
  envelope: Schema.String.check(Schema.isBetweenLength(1, maximumEnvelopeLength)),
});
const failed = (): ConnectionRetentionUnavailable => new ConnectionRetentionUnavailable();
export const sweepGrants = (
  input: Readonly<{
    db: D1Database;
    key: Option.Option<Redacted.Redacted<string>>;
    bank: Option.Option<ConnectionBankCleanup>;
  }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.key) || Option.isNone(input.bank)) return;
    const bank = input.bank.value;
    const key = input.key.value;
    const now = yield* Clock.currentTimeMillis;
    const claim = transactionId();
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`UPDATE connection_grants SET cleanup_claim=?,cleanup_after_ms=? WHERE attempt_id=(
    SELECT g.attempt_id FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id
    WHERE g.state='cleanup_required' AND g.envelope IS NOT NULL AND g.cleaned_at_ms IS NULL AND g.cleanup_after_ms<=? AND c.institution_id='bancolombia' AND b.consent_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining')
    ORDER BY g.cleanup_after_ms,g.claimed_at_ms,g.attempt_id LIMIT 1)
    RETURNING attempt_id`)
        .bind(claim, now + leaseMilliseconds, now)
        .all()
    );
    if (rows.results.length === 0) return;
    const selected = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT g.attempt_id AS attemptId,a.connection_id AS connectionId,c.user_id AS userId,b.consent_id AS consentId,b.intent_json AS intentJson,g.envelope,g.cleanup_access_seen AS accessSeen,g.cleanup_refresh_seen AS refreshSeen
    FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id
    WHERE g.cleanup_claim=? AND g.state='cleanup_required' AND g.cleaned_at_ms IS NULL LIMIT 1`)
        .bind(claim)
        .first()
    );
    const candidate = yield* Schema.decodeUnknownEffect(Candidate)(selected);
    yield* cleanClaim({ db: input.db, key, bank, claim, candidate }).pipe(
      Effect.onError(() =>
        Effect.tryPromise(() =>
          input.db
            .prepare(
              `UPDATE connection_grants SET cleanup_claim=NULL,cleanup_after_ms=? WHERE attempt_id=? AND cleanup_claim=? AND cleaned_at_ms IS NULL`
            )
            .bind(now + retryMilliseconds, candidate.attemptId, claim)
            .run()
        ).pipe(Effect.orElseSucceed(() => undefined))
      )
    );
  }).pipe(Effect.mapError(failed));

type Candidate = typeof Candidate.Type;
const cleanClaim = (
  input: Readonly<{
    db: D1Database;
    key: Redacted.Redacted<string>;
    bank: ConnectionBankCleanup;
    claim: string;
    candidate: Candidate;
  }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.gen(function* () {
    const { db, key, bank, claim, candidate } = input;
    const purpose = yield* grantPurpose({ ...candidate, clientId: bank.clientId });
    const grant = yield* openGrant({ key, purpose, envelope: candidate.envelope });
    yield* bank.revoke({
      grant,
      observedTokens: [
        ...(candidate.accessSeen === 1 ? ["access_token" as const] : []),
        ...(candidate.refreshSeen === 1 ? ["refresh_token" as const] : []),
      ],
      recordActive: (tokenType) => recordActive({ ...input, tokenType }),
    });
    const completed = yield* Clock.currentTimeMillis;
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `UPDATE connection_grants SET envelope=NULL,expires_at_ms=NULL,cleaned_at_ms=?,cleanup_claim=NULL WHERE attempt_id=? AND cleanup_claim=? AND state='cleanup_required' AND envelope=? AND cleanup_after_ms>?`
        )
        .bind(completed, candidate.attemptId, claim, candidate.envelope, completed)
        .run()
    );
    if (result.meta.changes !== 1) return yield* failed();
  }).pipe(Effect.timeout("60 seconds"), Effect.mapError(failed));

const recordActive = (
  input: Readonly<{
    db: D1Database;
    candidate: Candidate;
    claim: string;
    tokenType: "access_token" | "refresh_token";
  }>
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`UPDATE connection_grants SET cleanup_access_seen=CASE WHEN ?='access_token' THEN 1 ELSE cleanup_access_seen END,cleanup_refresh_seen=CASE WHEN ?='refresh_token' THEN 1 ELSE cleanup_refresh_seen END
    WHERE attempt_id=? AND cleanup_claim=? AND state='cleanup_required' AND envelope=? AND cleaned_at_ms IS NULL AND cleanup_after_ms>?`)
        .bind(
          input.tokenType,
          input.tokenType,
          input.candidate.attemptId,
          input.claim,
          input.candidate.envelope,
          current
        )
        .run()
    );
    if (result.meta.changes !== 1) return yield* new ConnectionAuthorizationUnavailable();
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));
