import {
  decodeProcessingConsentStatusRead,
  prepareProcessingConsentStatusRead,
} from "../../../src/shell/processing-consent/operations";
import { newId } from "../../secret-material/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { ProcessingAuthorization } from "../../../src/shell/processing-consent/contract";
import { DisclosureSnapshot } from "../../../src/shell/consent/contract";
import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { revocationEvidence } from "./evidence";
import type { ConsentWithdrawalAdmission } from "../contract";
import type { AuthenticatedWebSession } from "../../web-session/contract";

const unauthenticatedStatus = 401;
const unavailableStatus = 503;
const maximumAuthorizationTextLength = 32768;

export const consentResponse = (status: number): Response =>
  Response.json(
    {
      error: { code: status === unauthenticatedStatus ? "unauthenticated" : "consent_unavailable" },
    },
    {
      status,
      headers: { "cache-control": "no-store" },
    }
  );

const receiptQuery = (
  db: D1Database,
  subject: AuthenticatedWebSession,
  current: number
): D1PreparedStatement => {
  const read = prepareProcessingConsentStatusRead({ subject, current });
  return db.prepare(read.sql).bind(...read.params);
};
const presentReceipt = (rows: ReadonlyArray<unknown>): Effect.Effect<Response> =>
  decodeProcessingConsentStatusRead(rows).pipe(
    Effect.map(
      Option.match({
        onNone: () => consentResponse(unauthenticatedStatus),
        onSome: (status) => Response.json(status, { headers: { "cache-control": "no-store" } }),
      })
    ),
    Effect.orElseSucceed(() => consentResponse(unavailableStatus))
  );

export const readProcessingConsent = (
  input: Readonly<{
    db: D1Database;
    subject: AuthenticatedWebSession;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const result = yield* Effect.tryPromise(() =>
      receiptQuery(input.db, input.subject, current).all()
    );
    return yield* presentReceipt(result.results);
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));

export const readProcessingAuthorization = (
  input: Readonly<{ db: D1Database; subject: AuthenticatedWebSession }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const authority = webSessionCredentialAuthority({
      ...input,
      current: yield* Clock.currentTimeMillis,
    });
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT g.id AS reference,
    g.occurred_at_ms AS acceptedAtMs,CASE WHEN length(g.disclosure_json)<=? THEN g.disclosure_json ELSE NULL END AS disclosure
    FROM web_sessions w LEFT JOIN (SELECT * FROM consent_history WHERE record_type='processing_grant') g ON g.user_id=w.user_id
    WHERE w.id=? AND w.user_id=? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(
          maximumAuthorizationTextLength,
          input.subject.id,
          input.subject.userId,
          ...authority.bindings
        )
        .all()
    );
    if (result.results.length === 0) return consentResponse(unauthenticatedStatus);
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        reference: Schema.NullOr(Schema.String),
        acceptedAtMs: Schema.NullOr(Schema.Int),
        disclosure: Schema.NullOr(Schema.String),
      })
    )(result.results[0]);
    if (row.reference === null) {
      return Response.json({ authorization: null }, { headers: { "cache-control": "no-store" } });
    }
    const disclosure = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DisclosureSnapshot))(
      row.disclosure
    );
    const payload = yield* Schema.decodeUnknownEffect(ProcessingAuthorization)({
      authorization: { reference: row.reference, acceptedAtMs: row.acceptedAtMs, disclosure },
    });
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));

export const withdrawProcessingConsent = (
  input: Readonly<{
    db: D1Database;
    admission: typeof ConsentWithdrawalAdmission.Type;
    signal: AbortSignal;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.admission.deadlineMilliseconds) {
      return consentResponse(unavailableStatus);
    }
    const subject = {
      id: input.admission.sessionId,
      userId: input.admission.userId,
      digest: new Uint8Array(input.admission.digest),
    };
    const evidenceId = yield* Effect.sync(newId);
    const authority = webSessionCredentialAuthority({ subject, current });
    const auditId = yield* Effect.sync(newId);
    const results = yield* Effect.uninterruptible(
      Effect.tryPromise(() =>
        input.db.batch([
          revocationEvidence({ db: input.db, subject, current, evidenceId }),
          prepareAuthorizedAuditCall({
            db: input.db,
            authority,
            id: auditId,
            current,
            operation: "consent.withdraw",
            outcome: "accepted",
            afterOwnerWrite: true,
          }),
          receiptQuery(input.db, subject, current),
        ])
      )
    );
    return yield* presentReceipt(results.at(-1)?.results ?? []);
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));
