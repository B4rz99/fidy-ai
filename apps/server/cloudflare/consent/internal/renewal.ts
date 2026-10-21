import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { type Cause, Clock, Effect, Schema } from "effect";
import { ProcessingConsentRenewalReceipt } from "../../../src/shell/processing-consent/contract";
import {
  freshSessionConditions,
  webSessionCredentialAuthority,
} from "../../../src/shell/web-session/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { newId } from "../../secret-material/operations";
import type { ConsentRenewalAdmission } from "../contract";
import { consentResponse } from "./browser";

const forbiddenStatus = 403;
const unavailableStatus = 503;
type RenewalContext = Readonly<{
  db: D1Database;
  admission: typeof ConsentRenewalAdmission.Type;
  current: number;
  authority: ReturnType<typeof webSessionCredentialAuthority>;
}>;
type RenewalReceipt = Readonly<{
  reference: string;
  withdrawalReference: string;
  acceptedAtMs: number;
}>;

const renewalReceipt = (row: RenewalReceipt): Effect.Effect<Response> =>
  Schema.decodeEffect(ProcessingConsentRenewalReceipt)({ status: "Granted", renewal: row }).pipe(
    Effect.map((receipt) => Response.json(receipt, { headers: { "cache-control": "no-store" } })),
    Effect.orElseSucceed(() => consentResponse(unavailableStatus))
  );
const renewalContext = (
  db: D1Database,
  admission: typeof ConsentRenewalAdmission.Type,
  current: number
): RenewalContext => {
  const subject = {
    id: admission.sessionId,
    userId: admission.userId,
    digest: new Uint8Array(admission.digest),
  };
  const live = webSessionCredentialAuthority({ subject, current });
  const fresh = freshSessionConditions({
    session: { id: subject.id, user_id: subject.userId },
    current,
  });
  return {
    db,
    admission,
    current,
    authority: {
      ...live,
      predicate: `${live.predicate} AND ${fresh.sql}`,
      bindings: [...live.bindings, ...fresh.params],
    },
  };
};
const eligibleWithdrawal = ({ admission, authority }: RenewalContext): OwnedStatement => ({
  sql: `SELECT r.id FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) r JOIN (SELECT * FROM consent_history WHERE record_type='processing_grant') g ON g.id=r.grant_record_id
    WHERE r.id=? AND r.user_id=? AND g.user_id=? AND g.id=? AND json_extract(g.disclosure_json,'$.contentSha256')=?
    AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
  params: [
    admission.renewal.withdrawalReference,
    admission.userId,
    admission.userId,
    admission.renewal.authorizationReference,
    admission.renewal.disclosureSha256,
    ...authority.bindings,
  ],
});
const retryReceipt = ({
  db,
  admission,
  authority,
}: RenewalContext): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const decision = admission.renewal;
    const previous = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT n.id AS reference,n.withdrawal_id AS withdrawalReference,n.occurred_at_ms AS acceptedAtMs
    FROM (SELECT * FROM consent_history WHERE record_type='processing_renewal') n WHERE n.withdrawal_id=? AND n.user_id=? AND n.grant_record_id=?
    AND json_extract(n.disclosure_json,'$.contentSha256')=?
    AND NOT EXISTS(SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id=n.user_id)
    AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(
          decision.withdrawalReference,
          admission.userId,
          decision.authorizationReference,
          decision.disclosureSha256,
          ...authority.bindings
        )
        .all()
    );
    if (previous.results.length !== 1) {
      return consentResponse(forbiddenStatus);
    }
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        reference: Schema.String,
        withdrawalReference: Schema.String,
        acceptedAtMs: Schema.Int,
      })
    )(previous.results[0]);
    return yield* renewalReceipt(row);
  });
const commitRenewal = (
  { db, admission, current, authority }: RenewalContext,
  eligible: OwnedStatement
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const decision = admission.renewal;
    const reference = yield* Effect.sync(newId);
    const auditId = yield* Effect.sync(newId);
    yield* Effect.uninterruptible(
      Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(`INSERT INTO consent_history (record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,occurred_at_ms) SELECT 'processing_renewal',?,g.user_id,?,g.id,?,g.disclosure_json,? FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') g
      WHERE g.id=? AND g.user_id=? AND EXISTS(${eligible.sql})`)
            .bind(
              reference,
              decision.withdrawalReference,
              admission.sessionId,
              current,
              decision.authorizationReference,
              admission.userId,
              ...eligible.params
            ),
          prepareAuthorizedAuditCall({
            db,
            authority,
            id: auditId,
            current,
            operation: "consent.renew",
            outcome: "accepted",
            afterOwnerWrite: true,
          }),
          prepareChangedRowAssertion({ db, scope: "processing_consent_renewal" }),
        ])
      )
    );
    return yield* renewalReceipt({
      reference,
      withdrawalReference: decision.withdrawalReference,
      acceptedAtMs: current,
    });
  });

/** Append reacceptance that settles only its exact current cutoff in one User-coordinated unit. */
export const renewProcessingConsent = (
  input: Readonly<{
    db: D1Database;
    admission: typeof ConsentRenewalAdmission.Type;
    signal: AbortSignal;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.admission.deadlineMilliseconds) {
      return consentResponse(unavailableStatus);
    }
    const context = renewalContext(input.db, input.admission, current);
    const eligible = eligibleWithdrawal(context);
    const allowed = yield* Effect.tryPromise(() =>
      input.db
        .prepare(eligible.sql)
        .bind(...eligible.params)
        .all()
    );
    return yield* allowed.results.length === 1
      ? commitRenewal(context, eligible)
      : retryReceipt(context);
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));
