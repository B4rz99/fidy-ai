import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Predicate, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { InstitutionId } from "../../../src/core/connections/contract";
import { digestBytes, newId } from "../../secret-material/operations";
import {
  type ConnectionBankActivation,
  type ConnectionCallbackAdmission,
  ConnectionConsentIntent,
} from "../contract";
import { institutionsForUser } from "./institution-registration";
import { decodeGrantKey, grantPurpose, sealGrant } from "./grant";
import {
  type BrowserProof,
  type BrowserUnit,
  auditBrowser,
  failed,
  one,
  session,
} from "./sqlite-browser";
import { admitSynchronization } from "./synchronization";

const maxReferenceLength = 256;

const maximumAccounts = 1000;

const accountsSchema = Schema.Array(
  Schema.String.check(Schema.isBetweenLength(1, maxReferenceLength))
).check(Schema.isMaxLength(maximumAccounts));

const Pending = Schema.Struct({
  id: Schema.String,
  connectionId: Schema.String,
  consentId: Schema.String,
  verifier: Schema.String,
  intentJson: Schema.String,
  expiresAt: Schema.Int,
  withdrawal: Schema.Int,
});

const checkRegistration = Effect.fn(function* (user: string) {
  if (!(yield* institutionsForUser(user)).includes(InstitutionId.make("bancolombia"))) {
    return yield* failed();
  }
});

type Activation = {
  unit: BrowserUnit;
  proof: BrowserProof;
  callback: Pick<ConnectionCallbackAdmission, "state" | "result">;
  bank: ConnectionBankActivation;
  key: Redacted.Redacted<string>;
  canSynchronize: boolean;
};

const claimCallback = Effect.fn(function* ({ unit, proof, callback }: Activation) {
  const sql = yield* SqliteClient;
  const digest = Base64Url.encode(yield* digestBytes(new TextEncoder().encode(callback.state)));

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const who = yield* session(proof, unit.owns, { fresh: false, current: now });
      yield* checkRegistration(who.userId);

      const [row] =
        yield* sql`SELECT a.id,a.connection_id AS connectionId,b.consent_id AS consentId,b.verifier,b.intent_json AS intentJson,a.expires_at_ms AS expiresAt,
      (SELECT coalesce(max(rowid),0) FROM consent_history WHERE user_id=${who.userId} AND record_type='processing_withdrawal') AS withdrawal
      FROM connection_attempts a JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id
      WHERE c.user_id=${who.userId} AND c.state='Connecting' AND a.prepared_session_id=${who.id} AND a.status='consumed'
      AND a.expires_at_ms>${now} AND b.phase='prepared' AND b.state_digest=${digest} AND b.consent_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid)`;

      const attempt = yield* Schema.decodeUnknownEffect(Pending)(row);
      yield* one(
        yield* sql`INSERT INTO connection_grants(attempt_id,state,claimed_at_ms) VALUES(${attempt.id},'claimed',${now}) RETURNING attempt_id`
      );
      yield* one(
        yield* sql`UPDATE connection_authorizations SET phase='failed',verifier=NULL,handoff_url=NULL WHERE attempt_id=${attempt.id} AND phase='prepared' RETURNING attempt_id`
      );
      yield* auditBrowser(who, { operation: "connections.claimAuthorization", current: now });

      return { ...attempt, who };
    })
  );
});

const settleAccounts = Effect.fn(function* (
  { unit, proof, canSynchronize }: Activation,
  claim: Effect.Success<ReturnType<typeof claimCallback>>,
  accounts: ReadonlyArray<string>
) {
  const sql = yield* SqliteClient;

  const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(
    claim.intentJson
  );

  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const who = yield* session(proof, unit.owns, { fresh: false, current: now });
      yield* checkRegistration(who.userId);

      if (unit.request.signal.aborted || now >= claim.expiresAt || who.id !== claim.who.id) {
        return yield* failed();
      }

      yield* one(
        yield* sql`UPDATE connection_grants SET state='active' WHERE attempt_id=${claim.id} AND state='quarantined' AND expires_at_ms>${now}
        AND EXISTS(SELECT 1 FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.id=${claim.id} AND c.id=${claim.connectionId} AND c.user_id=${who.userId} AND c.state='Connecting'
          AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid))
        AND NOT EXISTS(SELECT 1 FROM consent_history WHERE user_id=${who.userId} AND record_type='processing_withdrawal' AND rowid>${claim.withdrawal}) RETURNING attempt_id`
      );
      yield* sql`UPDATE connection_grants SET state='cleanup_required' WHERE state='active' AND attempt_id<>${claim.id} AND attempt_id IN(SELECT id FROM connection_attempts WHERE connection_id=${claim.connectionId})`;

      yield* Effect.forEach(
        accounts,
        Effect.fnUntraced(function* (reference) {
          yield* sql`INSERT INTO connection_accounts(id,connection_id,provider_reference,grant_attempt_id) VALUES(${newId()},${claim.connectionId},${reference},${claim.id})
          ON CONFLICT(connection_id,provider_reference) DO UPDATE SET grant_attempt_id=excluded.grant_attempt_id`;
        }),
        { discard: true }
      );

      yield* one(
        yield* sql`UPDATE connections SET state='Active',updated_at_ms=${now} WHERE id=${claim.connectionId} AND user_id=${who.userId} AND state='Connecting' RETURNING id`
      );
      yield* auditBrowser(who, { operation: "connections.completeAuthorization", current: now });

      if (canSynchronize && intent.permissions.includes("ReadTransactionsDetail")) {
        yield* admitSynchronization(claim.id, now, unit.storage);
      }
    })
  );
});

export const activate = Effect.fn(function* (input: Activation) {
  const { callback, bank, key } = input;
  yield* decodeGrantKey(key);
  const sql = yield* SqliteClient;
  const claim = yield* claimCallback(input);

  const activation = Effect.gen(function* () {
    if (!Predicate.isTagged(callback.result, "Code")) return yield* failed();

    const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(
      claim.intentJson
    );

    const purpose = yield* grantPurpose({
      ...claim,
      userId: claim.who.userId,
      attemptId: claim.id,
      clientId: bank.clientId,
    });

    const accounts = yield* bank
      .activate({
        userId: claim.who.userId,
        code: Redacted.make(callback.result.code),
        state: callback.state,
        verifier: Redacted.make(claim.verifier),
        consentId: claim.consentId,
        intent,
        expiresAtMilliseconds: claim.expiresAt,
        retainGrant: (grant) =>
          Effect.gen(function* () {
            const envelope = yield* sealGrant({ key, purpose, grant });
            yield* one(
              yield* sql`UPDATE connection_grants SET state='quarantined',envelope=${envelope},expires_at_ms=${grant.expiresAtMilliseconds} WHERE attempt_id=${claim.id} AND state='claimed' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') RETURNING attempt_id`
            );
          }).pipe(Effect.mapError(failed)),
      })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(accountsSchema)));

    yield* settleAccounts(input, claim, accounts);
  });

  yield* activation.pipe(
    Effect.onError(() =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE connection_grants SET state='cleanup_required' WHERE attempt_id=${claim.id} AND state IN ('claimed','quarantined') AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;
            yield* sql`UPDATE connections SET state='Action required' WHERE id=${claim.connectionId} AND state='Connecting' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')
      AND NOT EXISTS(SELECT 1 FROM connection_attempts newer JOIN connection_attempts prior ON prior.id=${claim.id} WHERE newer.connection_id=prior.connection_id AND newer.rowid>prior.rowid)`;
          })
        )
        .pipe(Effect.orDie)
    )
  );
}, Effect.mapError(failed));
