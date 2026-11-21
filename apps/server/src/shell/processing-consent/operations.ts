import { Effect, Option, Schema } from "effect";
import { ProcessingConsentStatus } from "./contract";
import { webSessionCredentialAuthority } from "~/shell/web-session/operations";
import type { WebSessionSubject } from "~/shell/web-session/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";

const receiptRead = (condition: OwnedStatement): OwnedStatement => ({
  sql: `SELECT w.id AS id, w.user_id AS userId,
    CASE WHEN r.id IS NOT NULL THEN 'Revoked'
      WHEN EXISTS (SELECT 1 FROM consent_history g WHERE g.record_type='processing_grant' AND g.user_id=w.user_id) THEN 'Granted'
      ELSE 'Missing' END AS status,
    r.id AS reference, r.occurred_at_ms AS occurredAtMs
    FROM web_sessions w LEFT JOIN (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) r ON r.user_id = w.user_id
    WHERE ${condition.sql}`,
  params: condition.params,
});

export const prepareProcessingConsentStatusRead = ({
  subject,
  current,
}: Readonly<{ subject: WebSessionSubject; current: number }>): OwnedStatement => {
  const authority = webSessionCredentialAuthority({ subject, current });

  return receiptRead({
    sql: `w.id=? AND w.user_id=? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
    params: [subject.id, subject.userId, ...authority.bindings],
  });
};

const ReceiptRow = Schema.Struct({
  status: Schema.String,
  reference: Schema.NullOr(Schema.String),
  occurredAtMs: Schema.NullOr(Schema.Int),
});

export const decodeProcessingConsentStatusRead = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<Option.Option<ProcessingConsentStatus>, Schema.SchemaError> =>
  Effect.gen(function* () {
    if (rows.length === 0) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(ReceiptRow)(rows[0]);

    const result = yield* Schema.decodeUnknownEffect(ProcessingConsentStatus)({
      status: row.status,
      withdrawal:
        row.reference === null
          ? null
          : { reference: row.reference, occurredAtMs: row.occurredAtMs },
    });

    return Option.some(result);
  });

export const prepareSelectedProcessingConsentRead = (users: OwnedStatement): OwnedStatement =>
  receiptRead({ sql: `w.id IN (SELECT id FROM (${users.sql}))`, params: users.params });
