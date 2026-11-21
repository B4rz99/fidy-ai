import { sanitizeWorkTrace } from "../../runtime/telemetry/operations";
import { type Cause, Effect, Schema } from "effect";
import { RefundAttemptId } from "../../../src/core/subscription/contract";
import { type RefundReceiveInput } from "../contract";
import { WompiTransactionId } from "./wompi-model";
import { type RefundSubmission } from "./wompi-refund-client";

const maximumVerificationAttempts = 8;

const RefundWork = Schema.Union([
  Schema.Struct({
    traceContext: Schema.optionalKey(Schema.Unknown),
    version: Schema.Literal(1),
    kind: Schema.Literal("refund"),
    refundAttemptId: RefundAttemptId,
  }),
  Schema.Struct({
    traceContext: Schema.optionalKey(Schema.Unknown),
    version: Schema.Literal(1),
    kind: Schema.Literal("refund-void-verification"),
    refundAttemptId: RefundAttemptId,
    verification: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: maximumVerificationAttempts })
    ),
  }),
]);

export const RefundSubmissionSnapshot = Schema.Struct({
  id: RefundAttemptId,
  kind: Schema.Literals(["refund", "card-void"]),
  transaction_id: WompiTransactionId,
  amount_in_cents: Schema.Int,
  original_cents: Schema.Int,
  wompi_reference: Schema.String,
  wompi_source_id: Schema.Int,
});

export const isRefundWork = (body: unknown): boolean => Schema.is(RefundWork)(body);

export const submission = (row: typeof RefundSubmissionSnapshot.Type): RefundSubmission => ({
  id: row.id,
  kind: row.kind,
  transactionId: row.transaction_id,
  amountInCents: row.amount_in_cents,
  originalCents: row.original_cents,
  originalReference: row.wompi_reference,
  sourceId: row.wompi_source_id,
  reason: "Support billing correction",
});

export const receiveRefunds = (
  input: RefundReceiveInput
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.forEach(
    input.batch.messages,
    Effect.fnUntraced(function* (message) {
      const work = yield* Schema.decodeUnknownEffect(RefundWork)(message.body);
      const id = `refund-v1-${work.refundAttemptId}${work.kind === "refund" ? "" : `-verify-${work.verification}`}`;
      const params = yield* sanitizeWorkTrace(work);
      yield* Effect.tryPromise(() =>
        input.environment.BILLING_REFUND_WORKFLOW.create({
          id,
          params,
          retention: { successRetention: "3 days", errorRetention: "3 days" },
        })
      ).pipe(
        Effect.catch(() =>
          Effect.tryPromise(() => input.environment.BILLING_REFUND_WORKFLOW.get(id))
        )
      );
      message.ack();
    }),
    { discard: true }
  );
