import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { ConnectionAuthorizationHandoff } from "../../../src/shell/connections/contract";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankPreparation,
  type ConnectionBrowserAdmission,
  ConnectionConsentIntent,
} from "../contract";

const entropyBytes = 32;
const maximumPreparationMilliseconds = 30000;
const PreparationResult = Schema.Struct({
  url: ConnectionAuthorizationHandoff.fields.url,
  expiresAtMilliseconds: Schema.Int,
});
type Proof = Readonly<{
  verifier: Redacted.Redacted<string>;
  state: string;
  nonce: string;
  challenge: string;
  stateDigest: string;
  nonceDigest: string;
}>;

export const prepareProof = (
  bank: Option.Option<ConnectionBankPreparation>
): Effect.Effect<Option.Option<Proof>, ConnectionAuthorizationUnavailable> => {
  if (Option.isNone(bank)) return Effect.succeedNone;
  return Effect.gen(function* () {
    const secret = (): string =>
      Base64Url.encode(crypto.getRandomValues(new Uint8Array(entropyBytes)));
    const values = yield* Effect.try({
      try: () => ({ verifier: secret(), state: secret(), nonce: secret() }),
      catch: () => new ConnectionAuthorizationUnavailable(),
    });
    const hash = (value: string): Effect.Effect<string, ConnectionAuthorizationUnavailable> =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle
            .digest("SHA-256", new TextEncoder().encode(value))
            .then((bytes) => Base64Url.encode(new Uint8Array(bytes))),
        catch: () => new ConnectionAuthorizationUnavailable(),
      });
    return Option.some({
      verifier: Redacted.make(values.verifier),
      state: values.state,
      nonce: values.nonce,
      challenge: yield* hash(values.verifier),
      stateDigest: yield* hash(values.state),
      nonceDigest: yield* hash(values.nonce),
    });
  });
};

export const authorizationStatements = (
  input: Readonly<{
    db: D1Database;
    admission: ConnectionBrowserAdmission;
    current: number;
    proof: Option.Option<Proof>;
    intentJson: string;
  }>
): ReadonlyArray<D1PreparedStatement> =>
  Option.isNone(input.proof)
    ? []
    : [
        input.db
          .prepare(`INSERT INTO connection_authorizations(attempt_id,intent_json,verifier,state_digest,nonce_digest,phase,expires_at_ms)
  SELECT id,?,?,?,?, 'preparing',expires_at_ms FROM connection_attempts WHERE public_reference=? AND prepared_session_id=? AND consumed_at_ms=?`)
          .bind(
            input.intentJson,
            Redacted.value(input.proof.value.verifier),
            input.proof.value.stateDigest,
            input.proof.value.nonceDigest,
            input.admission.attempt,
            input.admission.sessionId,
            input.current
          ),
      ];

const ConsentId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u));
const recordConsent = (
  input: Readonly<{ db: D1Database; admission: ConnectionBrowserAdmission; consentId: string }>
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const consentId = yield* Schema.decodeEffect(ConsentId)(input.consentId);
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`UPDATE connection_authorizations SET consent_id=? WHERE phase='preparing' AND consent_id IS NULL AND attempt_id IN(
      SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.public_reference=? AND c.user_id=? AND a.prepared_session_id=?) RETURNING attempt_id`)
        .bind(consentId, input.admission.attempt, input.admission.userId, input.admission.sessionId)
        .all()
    );
    if (result.results.length !== 1) return yield* new ConnectionAuthorizationUnavailable();
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));

export const encodeConsentIntent = (
  bank: Option.Option<ConnectionBankPreparation>
): Effect.Effect<string, ConnectionAuthorizationUnavailable> =>
  Option.isNone(bank)
    ? Effect.succeed("{}")
    : Schema.encodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(bank.value.intent).pipe(
        Effect.mapError(() => new ConnectionAuthorizationUnavailable())
      );

export const settleAuthorization = (
  input: Readonly<{
    db: D1Database;
    admission: ConnectionBrowserAdmission;
    bank: ConnectionBankPreparation;
    proof: Proof;
    expiresAtMilliseconds: number;
  }>
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const remaining = Math.min(
      maximumPreparationMilliseconds,
      input.expiresAtMilliseconds - startedAt
    );
    const request =
      remaining <= 0
        ? Effect.fail(new ConnectionAuthorizationUnavailable())
        : Effect.suspend(() =>
            input.bank.prepare({
              userId: input.admission.userId,
              attempt: input.admission.attempt,
              state: input.proof.state,
              nonce: input.proof.nonce,
              challenge: input.proof.challenge,
              recordConsent: (consentId) => recordConsent({ ...input, consentId }),
              expiresAtMilliseconds: input.expiresAtMilliseconds,
            })
          );
    const prepared = yield* request.pipe(
      Effect.timeout(Math.max(0, remaining)),
      Effect.flatMap((value) => Schema.decodeEffect(PreparationResult)(value)),
      Effect.option
    );
    const now = yield* Clock.currentTimeMillis;
    const handoff = Option.filter(
      prepared,
      (value) =>
        value.expiresAtMilliseconds > now &&
        value.expiresAtMilliseconds <= input.expiresAtMilliseconds
    );
    yield* persistHandoff(input, handoff, now);
  });

const persistHandoff = (
  input: Parameters<typeof settleAuthorization>[0],
  handoff: Option.Option<typeof PreparationResult.Type>,
  now: number
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db.batch([
        input.db
          .prepare(`UPDATE connection_authorizations SET phase=?,handoff_url=?,verifier=CASE WHEN ?='failed' THEN NULL ELSE verifier END,expires_at_ms=min(expires_at_ms,?) WHERE attempt_id IN(
    SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.public_reference=? AND c.user_id=? AND a.prepared_session_id=?) AND phase='preparing' AND (?='failed' OR consent_id IS NOT NULL)`)
          .bind(
            Option.isSome(handoff) ? "prepared" : "failed",
            Option.isSome(handoff) ? handoff.value.url : null,
            Option.isSome(handoff) ? "prepared" : "failed",
            Option.isSome(handoff) ? handoff.value.expiresAtMilliseconds : now,
            input.admission.attempt,
            input.admission.userId,
            input.admission.sessionId,
            Option.isSome(handoff) ? "prepared" : "failed"
          ),
      ]),
    catch: () => new ConnectionAuthorizationUnavailable(),
  }).pipe(Effect.asVoid);
