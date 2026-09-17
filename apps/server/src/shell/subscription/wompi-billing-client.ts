import {
  Config,
  Context,
  Data,
  type DateTime,
  Effect,
  Layer,
  type Option,
  Result,
  Schema,
} from "effect";
import {
  WompiBillingStatus,
  WompiEnvironment,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import { type BillingEmail, WompiSourceId } from "~/core/subscription/enrollment-model";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";

const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const TransactionResponse = Schema.Struct({
  data: Schema.Struct({
    id: WompiTransactionId,
    reference: WompiTransactionReference,
    status: WompiBillingStatus,
    amount_in_cents: Schema.Int,
    currency: Schema.String,
    payment_source_id: WompiSourceId,
    finalized_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  }),
});
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);
const decodeTransaction = Schema.decodeUnknownResult(TransactionResponse);

const badRequestStatus = 400;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const unprocessableEntityStatus = 422;

/** Wompi processed the request and refused it; no transaction was created under the reference. */
const definitiveRefusalStatuses: ReadonlySet<number> = new Set([
  badRequestStatus,
  unauthorizedStatus,
  forbiddenStatus,
  unprocessableEntityStatus,
]);

export type WompiTransaction = Readonly<{
  transactionId: WompiTransactionId;
  reference: WompiTransactionReference;
  status: WompiBillingStatus;
  amountInCents: number;
  currency: string;
  sourceId: WompiSourceId;
  finalizedAt: Option.Option<DateTime.Utc>;
}>;

export class WompiTransactionCreationFailed extends Data.TaggedError(
  "WompiTransactionCreationFailed"
)<{ readonly certainty: "rejected" | "ambiguous" }> {}
export class WompiTransactionLookupFailed extends Data.TaggedError(
  "WompiTransactionLookupFailed"
)<{}> {}

export type WompiBillingClientService = Readonly<{
  environment: WompiEnvironment;
  createTransaction: (input: {
    reference: WompiTransactionReference;
    amountInCents: number;
    currency: string;
    billingEmail: BillingEmail;
    sourceId: WompiSourceId;
  }) => Effect.Effect<WompiTransaction, WompiTransactionCreationFailed>;
  findTransaction: (
    transactionId: WompiTransactionId
  ) => Effect.Effect<WompiTransaction, WompiTransactionLookupFailed>;
}>;

const parseTransaction = Effect.fn(function* (body: Uint8Array) {
  const json = decodeJson(new TextDecoder().decode(body));
  if (Result.isFailure(json)) return yield* Effect.fail("malformed" as const);
  const transaction = decodeTransaction(json.success);
  if (Result.isFailure(transaction)) return yield* Effect.fail("malformed" as const);
  const data = transaction.success.data;
  return {
    transactionId: data.id,
    reference: data.reference,
    status: data.status,
    amountInCents: data.amount_in_cents,
    currency: data.currency,
    sourceId: data.payment_source_id,
    finalizedAt: data.finalized_at,
  };
});

const makeCreateTransaction = (
  outboundHttp: OutboundHttpService
): WompiBillingClientService["createTransaction"] =>
  Effect.fn("Wompi.createTransaction")(
    function* (input) {
      const response = yield* outboundHttp
        .execute({
          _tag: "WompiCreateTransaction",
          body: {
            amountInCents: input.amountInCents,
            currency: input.currency,
            billingEmail: input.billingEmail,
            sourceId: input.sourceId,
            reference: input.reference,
          },
        })
        .pipe(Effect.timeout("14 seconds"));
      if (
        response.status < successfulStatusMinimum ||
        response.status >= successfulStatusMaximumExclusive
      ) {
        return yield* Effect.fail(
          definitiveRefusalStatuses.has(response.status)
            ? ("rejected" as const)
            : ("ambiguous" as const)
        );
      }
      return yield* parseTransaction(response.body);
    },
    Effect.mapError(
      (reason) =>
        new WompiTransactionCreationFailed({
          certainty: reason === "rejected" ? "rejected" : "ambiguous",
        })
    ),
    Effect.withSpan("Wompi.createTransaction", { attributes: { provider: "wompi" } })
  );

const makeFindTransaction = (
  outboundHttp: OutboundHttpService
): WompiBillingClientService["findTransaction"] =>
  Effect.fn("Wompi.findTransaction")(
    function* (transactionId) {
      const response = yield* outboundHttp
        .execute({
          _tag: "WompiFindTransaction",
          transactionId,
        })
        .pipe(Effect.timeout("14 seconds"));
      if (
        response.status < successfulStatusMinimum ||
        response.status >= successfulStatusMaximumExclusive
      ) {
        return yield* Effect.fail("provider-status" as const);
      }
      return yield* parseTransaction(response.body);
    },
    Effect.mapError(() => new WompiTransactionLookupFailed())
  );

const loadBillingAdapter = Effect.gen(function* () {
  const outboundHttp = yield* OutboundHttp;
  const environment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
  return WompiBillingClient.of({
    environment,
    createTransaction: makeCreateTransaction(outboundHttp),
    findTransaction: makeFindTransaction(outboundHttp),
  });
});

export class WompiBillingClient extends Context.Service<
  WompiBillingClient,
  WompiBillingClientService
>()("@fidy/server/shell/subscription/wompi-billing-client/WompiBillingClient") {
  static readonly layer = Layer.effect(WompiBillingClient, loadBillingAdapter);
}
