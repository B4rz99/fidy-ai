import { Data, DateTime, Effect, Schema } from "effect";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  allowanceConsumptionProof,
  prepareAvailableConsumption,
  quotaFailure,
} from "../../quotas/operations";

/** Composition of email processing admission, queued publication, and bounded deferral under fresh authority. */
export const prepareEmailProcessingAdmission = ({
  db,
  userId,
  receiptId,
  current,
  state,
}: Readonly<{
  db: D1Database;
  userId: string;
  receiptId: string;
  current: number;
  state: "storing" | "queued";
}>): ReadonlyArray<D1PreparedStatement> => {
  const authority = protectConsentStatement({
    subject: { _tag: "Owner", column: "r.user_id" },
    requirement: "active",
    statement: {
      sql: "SELECT r.user_id AS userId FROM forwarded_email_receipts r WHERE r.id = ? AND r.user_id = ? AND r.state = ? AND r.expires_at_ms > ? AND EXISTS (SELECT 1 FROM email_forwarding_addresses a WHERE a.user_id = r.user_id)",
      params: [receiptId, userId, state, current],
    },
  });
  const accepted = allowanceConsumptionProof({
    userId,
    allowance: "forwarded_email",
    identity: receiptId,
  });
  const reset = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt);
  return [
    ...prepareAvailableConsumption({
      db,
      userId,
      identity: receiptId,
      allowance: "forwarded_email",
      current,
      authority,
    }),
    db
      .prepare(
        "UPDATE forwarded_email_receipts SET state = 'queued' WHERE id = ? AND user_id = ? AND state = ?"
      )
      .bind(receiptId, userId, state),
    db
      .prepare(
        `INSERT INTO forwarded_email_deferrals SELECT id,user_id,?,? FROM forwarded_email_receipts WHERE id = ? AND user_id = ? AND state = 'queued' AND NOT EXISTS (${accepted.sql}) ON CONFLICT(receipt_id) DO UPDATE SET resume_at_ms = excluded.resume_at_ms,checked_at_ms = excluded.checked_at_ms`
      )
      .bind(reset, current, receiptId, userId, ...accepted.params),
    db
      .prepare(
        `INSERT INTO forwarded_email_outbox (receipt_id,user_id) SELECT id,user_id FROM forwarded_email_receipts WHERE id = ? AND user_id = ? AND state = 'queued' AND EXISTS (${accepted.sql}) ON CONFLICT(receipt_id) DO NOTHING`
      )
      .bind(receiptId, userId, ...accepted.params),
    db
      .prepare(
        `DELETE FROM forwarded_email_deferrals WHERE receipt_id = ? AND user_id = ? AND EXISTS (${accepted.sql})`
      )
      .bind(receiptId, userId, ...accepted.params),
  ];
};
class EmailAllowanceUnavailable extends Data.TaggedError("EmailAllowanceUnavailable")<{
  cause: unknown;
}> {}
const DeferredEmail = Schema.Struct({ receiptId: Schema.String, userId: Schema.String });

/** A fair, bounded sweep also reevaluates upgrades before reset; only processing activation consumes a unit. */
export const activateDeferredEmails = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<
  void,
  EmailAllowanceUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            "SELECT d.receipt_id AS receiptId,d.user_id AS userId FROM forwarded_email_deferrals d JOIN forwarded_email_receipts r ON r.id = d.receipt_id AND r.user_id = d.user_id WHERE r.state = 'queued' AND r.expires_at_ms > ? ORDER BY d.checked_at_ms,d.receipt_id LIMIT 25"
          )
          .bind(current)
          .all(),
      catch: (cause) => new EmailAllowanceUnavailable({ cause }),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DeferredEmail))(result.results);
    for (const row of rows) {
      // Maintenance scheduling is not processing admission: a revoked User must not
      // monopolize the head of the bounded sweep when the authority unit rolls back.
      yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(
              "UPDATE forwarded_email_deferrals SET checked_at_ms = MAX(checked_at_ms,?) WHERE receipt_id = ? AND user_id = ?"
            )
            .bind(current, row.receiptId, row.userId)
            .run(),
        catch: (cause) => new EmailAllowanceUnavailable({ cause }),
      });
      const activation = yield* Effect.tryPromise({
        try: () =>
          db.batch([...prepareEmailProcessingAdmission({ db, current, ...row, state: "queued" })]),
        catch: (cause) => new EmailAllowanceUnavailable({ cause }),
      }).pipe(Effect.result);
      if (activation._tag === "Failure" && quotaFailure(activation.failure.cause) !== "authority") {
        return yield* activation.failure;
      }
    }
  });
