import { Effect, Option, Schema } from "effect";
import { type OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { type RefundAttemptId } from "../../../src/core/subscription/contract";
import { WompiTransactionId } from "./wompi-model";

const maximumReferenceLength = 128;
const successMinimum = 200;
const successMaximumExclusive = 300;
const RefundBody = Schema.fromJsonString(
  Schema.Struct({
    transaction_id: WompiTransactionId,
    amount_in_cents: Schema.Int,
    reference: Schema.String,
    reason: Schema.String,
  })
);
const RefundResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      v2_refund_id: Schema.optionalKey(
        Schema.NullOr(
          Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumReferenceLength))
        )
      ),
      status: Schema.Literals(["APPROVED", "DECLINED", "CANCELLED", "ERROR", "PENDING"]),
      transaction_id: WompiTransactionId,
      amount_in_cents: Schema.Int,
      reference: Schema.String,
    }),
  })
);
const VoidResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      id: WompiTransactionId,
      status: Schema.String,
      reference: Schema.String,
      amount_in_cents: Schema.Int,
      currency: Schema.String,
      payment_source_id: Schema.Int,
    }),
  })
);
export type RefundSubmission = Readonly<{
  id: RefundAttemptId;
  kind: "refund" | "card-void";
  transactionId: WompiTransactionId;
  amountInCents: number;
  originalCents: number;
  originalReference: string;
  sourceId: number;
  reason: string;
}>;
export type RefundEvidence = Readonly<{
  providerId: string;
  status: "APPROVED" | "DECLINED" | "CANCELLED" | "VOIDED";
}>;
const refundReference = (id: RefundAttemptId): string => `fidy-refund-${id}`;
const parseRefund = (
  body: Uint8Array,
  input: RefundSubmission
): Effect.Effect<Option.Option<RefundEvidence>> =>
  Schema.decodeEffect(RefundResponse)(new TextDecoder().decode(body)).pipe(
    Effect.map(({ data }) => {
      if (
        data.transaction_id !== input.transactionId ||
        data.amount_in_cents !== input.amountInCents ||
        data.reference !== refundReference(input.id)
      ) {
        return Option.none();
      }
      if (data.status === "ERROR" || data.status === "PENDING") return Option.none();
      return Option.some({ providerId: data.v2_refund_id ?? String(data.id), status: data.status });
    }),
    Effect.catch(() => Effect.succeedNone)
  );
const parseVoid = (
  body: Uint8Array,
  input: RefundSubmission
): Effect.Effect<Option.Option<RefundEvidence>> =>
  Schema.decodeEffect(VoidResponse)(new TextDecoder().decode(body)).pipe(
    Effect.map(({ data }) =>
      data.id === input.transactionId &&
      data.status === "VOIDED" &&
      data.amount_in_cents === input.originalCents &&
      data.reference === input.originalReference &&
      data.currency === "COP" &&
      data.payment_source_id === input.sourceId
        ? Option.some({ providerId: data.id, status: "VOIDED" as const })
        : Option.none()
    ),
    Effect.catch(() => Effect.succeedNone)
  );
/** One claimed mutation only. Unknown/malformed responses cannot authorize release or settlement. */
export const submitCorrection = ({
  http,
  input,
}: Readonly<{ http: OutboundHttpService; input: RefundSubmission }>): Effect.Effect<
  Option.Option<RefundEvidence>
> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(RefundBody)({
      transaction_id: input.transactionId,
      amount_in_cents: input.amountInCents,
      reference: refundReference(input.id),
      reason: input.reason,
    });
    const response = yield* http.execute(
      input.kind === "refund"
        ? { _tag: "WompiSandboxRefund", body }
        : { _tag: "WompiSandboxCardVoid", transactionId: input.transactionId }
    );
    if (response.status < successMinimum || response.status >= successMaximumExclusive) {
      return Option.none();
    }
    return yield* input.kind === "refund"
      ? parseRefund(response.body, input)
      : parseVoid(response.body, input);
  }).pipe(
    Effect.timeout("14 seconds"),
    Effect.catch(() => Effect.succeedNone)
  );
/** Voids can be reconciled through the documented transaction lookup, never by disabling a source. */
export const verifyCardVoid = ({
  http,
  input,
}: Readonly<{ http: OutboundHttpService; input: RefundSubmission }>): Effect.Effect<
  Option.Option<RefundEvidence>
> =>
  http.execute({ _tag: "WompiFindTransaction", transactionId: input.transactionId }).pipe(
    Effect.flatMap((response) =>
      response.status >= successMinimum && response.status < successMaximumExclusive
        ? parseVoid(response.body, input)
        : Effect.succeedNone
    ),
    Effect.timeout("14 seconds"),
    Effect.catch(() => Effect.succeedNone)
  );
