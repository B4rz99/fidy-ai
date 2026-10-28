import { digestBytes } from "../../secret-material/operations";
import { Clock, Crypto, Effect, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { callerAuthority, transactionId } from "../../canonical-work/operations";
import {
  ConnectionActivation,
  ConnectionAuthorizationUnavailable,
  type ConnectionBankGrant,
  type ConnectionCallbackAdmission,
  ConnectionConsentIntent,
  ConnectionGrantKey,
} from "../contract";
import { institutionsForUser } from "./institution-registration";
import { decodeGrantKey, grantPurpose, sealGrant } from "./grant";
import { InstitutionId } from "../../../src/core/connections/contract";

const Claim = Schema.Struct({
  attemptId: Schema.String,
  connectionId: Schema.String,
  consentId: Schema.String,
  verifier: Schema.String,
  intentJson: Schema.String,
  expiresAtMilliseconds: Schema.Int,
  withdrawalGeneration: Schema.Int,
});
type Claim = typeof Claim.Type;
type Input = Readonly<{
  db: D1Database;
  admission: ConnectionCallbackAdmission;
  signal: AbortSignal;
}>;
const failed = (): ConnectionAuthorizationUnavailable => new ConnectionAuthorizationUnavailable();
const authorityFor = (input: Input, current: number): ReturnType<typeof callerAuthority> =>
  callerAuthority({
    current,
    subject: {
      id: input.admission.sessionId,
      userId: input.admission.userId,
      digest: new Uint8Array(input.admission.digest),
    },
  });
const stateDigest = (state: string): Effect.Effect<string, ConnectionAuthorizationUnavailable> =>
  digestBytes(new TextEncoder().encode(state)).pipe(
    Effect.map(Base64Url.encode),
    Effect.mapError(failed)
  );

const claimCallback = (input: Input): Effect.Effect<Claim, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.admission.deadlineMilliseconds) {
      return yield* failed();
    }
    if (
      !(yield* institutionsForUser(input.admission.userId)).includes(
        InstitutionId.make("bancolombia")
      )
    ) {
      return yield* failed();
    }
    const digest = yield* stateDigest(input.admission.state);
    const authority = authorityFor(input, current);
    const { db, admission } = input;
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO connection_grants(attempt_id,state,claimed_at_ms)
      SELECT a.id,'claimed',? FROM connection_attempts a JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id
      WHERE a.public_reference=? AND c.user_id=? AND c.institution_id='bancolombia' AND c.state='Connecting'
      AND a.prepared_session_id=? AND a.status='consumed' AND a.expires_at_ms>? AND b.phase='prepared' AND b.state_digest=? AND b.consent_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid)
      AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
          .bind(
            current,
            admission.attempt,
            admission.userId,
            admission.sessionId,
            current,
            digest,
            ...authority.bindings
          ),
        prepareChangedRowAssertion({ db, scope: "connection_browser" }),
        db
          .prepare(`SELECT a.id AS attemptId,c.id AS connectionId,b.consent_id AS consentId,b.verifier,b.intent_json AS intentJson,a.expires_at_ms AS expiresAtMilliseconds,
      (SELECT coalesce(max(h.rowid),0) FROM consent_history h WHERE h.record_type='processing_withdrawal' AND h.user_id=c.user_id) AS withdrawalGeneration
      FROM connection_attempts a JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id JOIN connection_grants g ON g.attempt_id=a.id
      WHERE a.public_reference=? AND c.user_id=? AND g.state='claimed' AND g.claimed_at_ms=?`)
          .bind(admission.attempt, admission.userId, current),
        db
          .prepare(`UPDATE connection_authorizations SET phase='failed',verifier=NULL,handoff_url=NULL
      WHERE attempt_id IN(SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.public_reference=? AND c.user_id=?) AND phase='prepared'`)
          .bind(admission.attempt, admission.userId),
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          operation: "connections.claimAuthorization",
          current,
          outcome: "accepted",
          afterOwnerWrite: false,
        }),
      ])
    );
    return yield* Schema.decodeUnknownEffect(Claim)(results[2]?.results[0]);
  }).pipe(Effect.mapError(failed));

const retainGrant = (
  input: Input,
  claim: Claim,
  retained: Readonly<{ grant: ConnectionBankGrant; clientId: string }>
): Effect.Effect<void, ConnectionAuthorizationUnavailable, Crypto.Crypto> =>
  Effect.gen(function* () {
    const key = yield* ConnectionGrantKey;
    if (Option.isNone(key)) return yield* failed();
    const purpose = yield* grantPurpose({
      ...claim,
      userId: input.admission.userId,
      clientId: retained.clientId,
    });
    const envelope = yield* sealGrant({ key: key.value, purpose, grant: retained.grant });
    yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            "UPDATE connection_grants SET state='quarantined',envelope=?,expires_at_ms=? WHERE attempt_id=? AND state='claimed'"
          )
          .bind(envelope, retained.grant.expiresAtMilliseconds, claim.attemptId),
        prepareChangedRowAssertion({ db: input.db, scope: "connection_browser" }),
      ])
    );
  }).pipe(Effect.mapError(failed));

const settleAccounts = (
  input: Input,
  claim: Claim,
  accounts: ReadonlyArray<string>
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= claim.expiresAtMilliseconds) return yield* failed();
    if (
      !(yield* institutionsForUser(input.admission.userId)).includes(
        InstitutionId.make("bancolombia")
      )
    ) {
      return yield* failed();
    }
    const authority = authorityFor(input, current);
    const { db } = input;
    const rows = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Array(Schema.Struct({ id: Schema.String, reference: Schema.String }))
      )
    )(accounts.map((reference) => ({ id: transactionId(), reference })));
    yield* Effect.tryPromise(() =>
      db.batch([
        activateGrantStatement(input, claim, current),
        prepareChangedRowAssertion({ db, scope: "connection_browser" }),
        db
          .prepare(
            `UPDATE connection_grants SET state='cleanup_required' WHERE state='active' AND attempt_id<>? AND attempt_id IN(SELECT id FROM connection_attempts WHERE connection_id=?)`
          )
          .bind(claim.attemptId, claim.connectionId),
        db
          .prepare(`INSERT INTO connection_accounts(id,connection_id,provider_reference,grant_attempt_id)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.reference'),? FROM json_each(?) WHERE true
      ON CONFLICT(connection_id,provider_reference) DO UPDATE SET grant_attempt_id=excluded.grant_attempt_id`)
          .bind(claim.connectionId, claim.attemptId, rows),
        db
          .prepare(
            "UPDATE connections SET state='Active',updated_at_ms=? WHERE id=? AND user_id=? AND state='Connecting'"
          )
          .bind(current, claim.connectionId, input.admission.userId),
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          operation: "connections.completeAuthorization",
          current,
          outcome: "accepted",
          afterOwnerWrite: true,
        }),
        prepareChangedRowAssertion({ db, scope: "connection_browser" }),
      ])
    );
  }).pipe(Effect.mapError(failed));

const activateGrantStatement = (
  input: Input,
  claim: Claim,
  current: number
): D1PreparedStatement => {
  const authority = authorityFor(input, current);
  return input.db
    .prepare(`UPDATE connection_grants SET state='active' WHERE attempt_id=? AND state='quarantined' AND expires_at_ms>?
      AND EXISTS(SELECT 1 FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.id=connection_grants.attempt_id AND c.id=? AND c.user_id=? AND c.state='Connecting'
       AND NOT EXISTS(SELECT 1 FROM consent_history h WHERE h.record_type='processing_withdrawal' AND h.user_id=c.user_id AND h.rowid>?)
       AND a.expires_at_ms>? AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid))
      AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      claim.attemptId,
      current,
      claim.connectionId,
      input.admission.userId,
      claim.withdrawalGeneration,
      current,
      ...authority.bindings
    );
};

const failClaim = (
  input: Input,
  claim: Claim
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db.batch([
        input.db
          .prepare(
            "UPDATE connection_grants SET state='cleanup_required' WHERE attempt_id=? AND state IN ('claimed','quarantined')"
          )
          .bind(claim.attemptId),
        input.db
          .prepare(`UPDATE connections SET state='Action required' WHERE id=? AND user_id=? AND state='Connecting'
      AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=connections.id AND newer.rowid>(SELECT rowid FROM connection_attempts WHERE id=?))
      AND EXISTS(SELECT 1 FROM connection_grants WHERE attempt_id=? AND state='cleanup_required')`)
          .bind(claim.connectionId, input.admission.userId, claim.attemptId, claim.attemptId),
      ]),
    catch: failed,
  }).pipe(Effect.asVoid);

export const completeAuthorization = (
  input: Input
): Effect.Effect<void, ConnectionAuthorizationUnavailable, Crypto.Crypto> =>
  Effect.gen(function* () {
    const bank = yield* ConnectionActivation;
    const key = yield* ConnectionGrantKey;
    if (Option.isNone(bank) || Option.isNone(key)) return yield* failed();
    yield* decodeGrantKey(key.value);
    const claim = yield* claimCallback(input);
    const entropy = yield* Crypto.Crypto;
    const activation = Effect.gen(function* () {
      const result = input.admission.result;
      if (result._tag === "Denied") return yield* failed();
      const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(
        claim.intentJson
      );
      const accounts = yield* bank.value.activate({
        userId: input.admission.userId,
        code: Redacted.make(result.code),
        state: input.admission.state,
        verifier: Redacted.make(claim.verifier),
        consentId: claim.consentId,
        intent,
        expiresAtMilliseconds: claim.expiresAtMilliseconds,
        retainGrant: (grant) =>
          retainGrant(input, claim, { grant, clientId: bank.value.clientId }).pipe(
            Effect.provideService(Crypto.Crypto, entropy)
          ),
      });
      yield* settleAccounts(input, claim, accounts);
    }).pipe(Effect.mapError(failed));
    yield* activation.pipe(
      Effect.onError(() => failClaim(input, claim).pipe(Effect.orElseSucceed(() => undefined)))
    );
  });
