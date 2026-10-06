import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { RefundAttemptId } from "../../../src/core/subscription/contract";
import {
  type RefundDispatchInput,
  type RefundReceiveInput,
  type RefundWorkflowExecution,
} from "../contract";
import { WompiTransactionId } from "./wompi-model";
import { wompiOutboundHttp } from "./wompi-runtime";
import {
  type RefundEvidence,
  type RefundSubmission,
  submitCorrection,
  verifyCardVoid,
} from "./wompi-refund-client";

const maximumVerificationAttempts = 8;
const RefundWork = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("refund"),
    refundAttemptId: RefundAttemptId,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("refund-void-verification"),
    refundAttemptId: RefundAttemptId,
    verification: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: maximumVerificationAttempts })
    ),
  }),
]);
const Snapshot = Schema.Struct({
  id: RefundAttemptId,
  kind: Schema.Literals(["refund", "card-void"]),
  transaction_id: WompiTransactionId,
  amount_in_cents: Schema.Int,
  original_cents: Schema.Int,
  wompi_reference: Schema.String,
  wompi_source_id: Schema.Int,
});
const noRetry = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: "30 seconds",
} as const;
const pendingLimit = 32;
const publicationCooldownMs = 60_000;
export const isRefundWork = (body: unknown): boolean => Schema.is(RefundWork)(body);
const submission = (row: typeof Snapshot.Type): RefundSubmission => ({
  id: row.id,
  kind: row.kind,
  transactionId: row.transaction_id,
  amountInCents: row.amount_in_cents,
  originalCents: row.original_cents,
  originalReference: row.wompi_reference,
  sourceId: row.wompi_source_id,
  reason: "Support billing correction",
});
const settle = (
  db: D1Database,
  id: RefundAttemptId,
  evidence: Option.Option<RefundEvidence>
): Effect.Effect<void, Cause.UnknownError> => {
  if (Option.isNone(evidence)) {
    return Effect.tryPromise(() =>
      db
        .prepare(
          "UPDATE refund_attempts SET progress='outcome-unknown' WHERE id=? AND status='pending'"
        )
        .bind(id)
        .run()
    ).pipe(Effect.asVoid);
  }
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((current) =>
      Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO refund_outcome_evidence(refund_id,provider_id,verified_status,observed_at_ms)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM refund_attempts WHERE id=? AND status='pending')
    ON CONFLICT(refund_id) DO NOTHING`)
          .bind(id, evidence.value.providerId, evidence.value.status, current, id)
          .run()
      )
    ),
    Effect.asVoid
  );
};
const submissionClaim = (
  db: D1Database,
  work: typeof RefundWork.Type
): Effect.Effect<"claimed" | "existing" | "absent", Cause.UnknownError> => {
  const id = work.refundAttemptId;
  if (work.kind === "refund-void-verification") {
    return Effect.tryPromise(() =>
      db
        .prepare(`SELECT c.refund_id FROM refund_submission_claims c
      JOIN refund_outbox o ON o.refund_id=c.refund_id WHERE c.refund_id=? AND o.verification_attempts>=?`)
        .bind(id, work.verification)
        .first()
    ).pipe(Effect.map((row) => (row === null ? ("absent" as const) : ("existing" as const))));
  }
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((current) =>
      Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(`INSERT INTO refund_submission_claims(refund_id,claimed_at_ms) VALUES (?,?)
      ON CONFLICT(refund_id) DO NOTHING RETURNING refund_id`)
            .bind(id, current),
          db
            .prepare(`UPDATE refund_attempts SET progress='verifying' WHERE id=? AND status='pending'
          AND EXISTS (SELECT 1 FROM refund_submission_claims WHERE refund_id=refund_attempts.id)`)
            .bind(id),
        ])
      )
    ),
    Effect.flatMap((results) =>
      results[0]?.results.length === 1
        ? Effect.succeed("claimed" as const)
        : Effect.tryPromise(() =>
            db
              .prepare("SELECT refund_id FROM refund_submission_claims WHERE refund_id=?")
              .bind(id)
              .first()
          ).pipe(Effect.map((row) => (row === null ? ("absent" as const) : ("existing" as const))))
    )
  );
};
const execute = (
  input: RefundWorkflowExecution
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { environment } = input;
    const work = yield* Schema.decodeUnknownEffect(RefundWork)(input.payload);
    // Both the charge snapshot and the current key/environment must stay Sandbox. No boolean enables real money.
    if (
      environment.WOMPI_ENVIRONMENT !== "sandbox" ||
      !environment.WOMPI_PRIVATE_KEY.startsWith("prv_test_")
    ) {
      return;
    }
    const raw = yield* Effect.tryPromise(() =>
      environment.DB.prepare(`SELECT r.id,r.kind,r.transaction_id,r.amount_in_cents,
    r.original_cents,a.wompi_reference,s.wompi_source_id FROM refund_attempts r
    JOIN billing_attempts a ON a.id=r.billing_attempt_id JOIN card_payment_sources s ON s.id=a.payment_source_id
    WHERE r.id=? AND r.status='pending' AND a.wompi_environment='sandbox'
      AND (SELECT COUNT(*) FROM billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1`)
        .bind(work.refundAttemptId)
        .first()
    );
    if (raw === null) return;
    const captured = submission(yield* Schema.decodeUnknownEffect(Snapshot)(raw));
    const claimed = yield* submissionClaim(environment.DB, work);
    if (claimed === "absent") return;
    const http = yield* wompiOutboundHttp({ ...environment, WOMPI_ENVIRONMENT: "sandbox" });
    if (claimed === "claimed") {
      yield* settle(
        environment.DB,
        captured.id,
        yield* submitCorrection({ http, input: captured })
      );
    } else if (captured.kind === "card-void") {
      yield* settle(environment.DB, captured.id, yield* verifyCardVoid({ http, input: captured }));
    } else {
      // A refund lookup/webhook/retry contract is not yet established. Never invent a safe retry.
      yield* settle(environment.DB, captured.id, Option.none());
    }
  });
export const runRefundWorkflow = (input: RefundWorkflowExecution): Promise<void> =>
  input.activity("submit-or-verify-correction-v1", noRetry, () =>
    Effect.runPromise(execute(input))
  );

/** A missed or duplicated publication is recoverable; the durable claim, not Workflow history, prevents another POST. */
export const dispatchRefunds = (
  input: RefundDispatchInput
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.tryPromise(() =>
      input.DB.prepare(`SELECT o.refund_id FROM refund_outbox o
      JOIN refund_attempts r ON r.id=o.refund_id WHERE r.status='pending' AND r.progress='queued'
      AND NOT EXISTS (SELECT 1 FROM refund_submission_claims c WHERE c.refund_id=r.id)
      AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms<=?) ORDER BY r.created_at_ms LIMIT ?`)
        .bind(now - publicationCooldownMs, pendingLimit)
        .all()
    );
    const pending = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ refund_id: RefundAttemptId }))
    )(rows.results);
    for (const row of pending) {
      yield* Effect.tryPromise(() =>
        input.DB.prepare("UPDATE refund_outbox SET last_attempt_at_ms=? WHERE refund_id=?")
          .bind(now, row.refund_id)
          .run()
      );
      yield* Effect.tryPromise(() =>
        input.BILLING_COLLECTION_QUEUE.send({
          version: 1,
          kind: "refund",
          refundAttemptId: row.refund_id,
        })
      );
      yield* Effect.tryPromise(() =>
        input.DB.prepare("UPDATE refund_outbox SET published_at_ms=? WHERE refund_id=?")
          .bind(now, row.refund_id)
          .run()
      );
    }
  });
/** Only documented card-transaction GETs are retried; uncertain Refund V2 mutations await a confirmed lookup contract. */
export const dispatchVoidVerification = (
  input: RefundDispatchInput
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.tryPromise(() =>
      input.DB.prepare(`SELECT r.id FROM refund_attempts r
    JOIN refund_outbox o ON o.refund_id=r.id JOIN refund_submission_claims c ON c.refund_id=r.id
    WHERE r.status='pending' AND r.kind='card-void' AND o.verification_attempts<?
    AND (o.last_verification_at_ms IS NULL OR o.last_verification_at_ms<=?) ORDER BY r.created_at_ms LIMIT ?`)
        .bind(maximumVerificationAttempts, now - publicationCooldownMs, pendingLimit)
        .all()
    );
    const pending = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ id: RefundAttemptId }))
    )(rows.results);
    for (const row of pending) {
      const advanced = yield* Effect.tryPromise(() =>
        input.DB.prepare(`UPDATE refund_outbox SET verification_attempts=verification_attempts+1,
      last_verification_at_ms=? WHERE refund_id=? AND verification_attempts<?
      AND (last_verification_at_ms IS NULL OR last_verification_at_ms<=?) RETURNING verification_attempts`)
          .bind(now, row.id, maximumVerificationAttempts, now - publicationCooldownMs)
          .first()
      );
      if (advanced === null) continue;
      const revision = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ verification_attempts: Schema.Int })
      )(advanced);
      yield* Effect.tryPromise(() =>
        input.BILLING_COLLECTION_QUEUE.send({
          version: 1,
          kind: "refund-void-verification",
          refundAttemptId: row.id,
          verification: revision.verification_attempts,
        })
      );
    }
  });

export const receiveRefunds = (
  input: RefundReceiveInput
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = yield* Schema.decodeUnknownEffect(RefundWork)(message.body);
      const id = `refund-v1-${work.refundAttemptId}${work.kind === "refund" ? "" : `-verify-${work.verification}`}`;
      yield* Effect.tryPromise(() =>
        input.environment.BILLING_REFUND_WORKFLOW.create({
          id,
          params: work,
          retention: { successRetention: "3 days", errorRetention: "3 days" },
        })
      ).pipe(
        Effect.catch(() =>
          Effect.tryPromise(() => input.environment.BILLING_REFUND_WORKFLOW.get(id))
        )
      );
      message.ack();
    }
  });
