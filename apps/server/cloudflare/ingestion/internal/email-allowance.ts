import { Data, Effect, Schema } from "effect";
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
    requirement: state === "queued" ? "granted" : "active",
    statement: {
      sql: "SELECT r.user_id AS userId FROM forwarded_email_receipts r WHERE r.id = ? AND r.user_id = ? AND r.state = ? AND r.expires_at_ms > ? AND EXISTS (SELECT 1 FROM users a WHERE a.id=r.user_id AND a.forwarding_address_id IS NOT NULL)",
      params: [receiptId, userId, state, current],
    },
  });
  const accepted = allowanceConsumptionProof({
    userId,
    allowance: "forwarded_email",
    identity: receiptId,
  });
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
        `UPDATE forwarded_email_receipts SET state = 'queued',deferred_checked_at_ms = CASE WHEN EXISTS (${accepted.sql}) THEN NULL ELSE ? END WHERE id = ? AND user_id = ? AND state = ?`
      )
      .bind(...accepted.params, current, receiptId, userId, state),
    db
      .prepare(
        `UPDATE forwarded_email_receipts SET dispatch_user_id=user_id
        WHERE id=? AND user_id=? AND state='queued' AND dispatch_user_id IS NULL AND EXISTS (${accepted.sql})`
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
            "SELECT r.id AS receiptId,r.user_id AS userId FROM forwarded_email_receipts r WHERE r.deferred_checked_at_ms IS NOT NULL AND r.state = 'queued' AND r.expires_at_ms > ? ORDER BY r.deferred_checked_at_ms,r.id LIMIT 25"
          )
          .bind(current)
          .all(),
      catch: (cause) => new EmailAllowanceUnavailable({ cause }),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DeferredEmail))(result.results);
    for (const row of rows) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(
              "UPDATE forwarded_email_receipts SET deferred_checked_at_ms = MAX(deferred_checked_at_ms,?) WHERE id = ? AND user_id = ? AND deferred_checked_at_ms IS NOT NULL"
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
