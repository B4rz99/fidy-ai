import {
  Config,
  Context,
  Crypto,
  Data,
  type DateTime,
  Effect,
  Encoding,
  Layer,
  type Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  WompiBillingStatus,
  WompiEnvironment,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import { BillingEmail, WompiSourceId } from "~/core/subscription/enrollment-model";
import { UnknownJsonString, jsonStringSchema } from "~/schema-compatibility";
import { makeBoundedExternalHttpClient } from "~/shell/_shared/bounded-external-http";

const maximumProviderResponseBytes = 16_384;
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const serverErrorStatusMinimum = 500;
const sandboxOrigin = "https://sandbox.wompi.co";
const productionOrigin = "https://production.wompi.co";

const PrivateKey = Schema.String.check(Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u));
const IntegritySecret = Schema.String.check(
  Schema.isPattern(/^test_integrity_[A-Za-z0-9_-]{8,}$|^prod_integrity_[A-Za-z0-9_-]{8,}$/u)
);
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
const CreateTransactionRequest = Schema.Struct({
  amount_in_cents: Schema.Int,
  currency: Schema.String,
  customer_email: BillingEmail,
  payment_method: Schema.Struct({ installments: Schema.Literal(1) }),
  payment_source_id: WompiSourceId,
  reference: WompiTransactionReference,
  signature: Schema.String,
});
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);
const decodeTransaction = Schema.decodeUnknownResult(TransactionResponse);
const encodeCreateRequest = Schema.encodeSync(jsonStringSchema(CreateTransactionRequest));

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

type BoundedHttpClient = ReturnType<ReturnType<typeof makeBoundedExternalHttpClient>>;
type BillingAdapterContext = Readonly<{
  http: BoundedHttpClient;
  crypto: Crypto.Crypto;
  integrityValue: string;
  origin: string;
  authorization: string;
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
  context: BillingAdapterContext
): WompiBillingClientService["createTransaction"] =>
  Effect.fn("Wompi.createTransaction")(
    function* (input) {
      const digest = yield* context.crypto.digest(
        "SHA-256",
        new TextEncoder().encode(
          `${input.reference}${input.amountInCents}${input.currency}${context.integrityValue}`
        )
      );
      const request = HttpClientRequest.post(`${context.origin}/v1/transactions`, {
        headers: { authorization: context.authorization, "content-type": "application/json" },
        body: HttpBody.text(
          encodeCreateRequest({
            amount_in_cents: input.amountInCents,
            currency: input.currency,
            customer_email: input.billingEmail,
            payment_method: { installments: 1 },
            payment_source_id: input.sourceId,
            reference: input.reference,
            signature: Encoding.encodeHex(digest),
          }),
          "application/json"
        ),
      });
      const response = yield* context.http
        .execute(request, maximumProviderResponseBytes)
        .pipe(Effect.timeout("14 seconds"));
      if (
        response.status < successfulStatusMinimum ||
        response.status >= successfulStatusMaximumExclusive
      ) {
        return yield* Effect.fail(
          response.status >= serverErrorStatusMinimum
            ? ("ambiguous" as const)
            : ("rejected" as const)
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
  context: BillingAdapterContext
): WompiBillingClientService["findTransaction"] =>
  Effect.fn("Wompi.findTransaction")(
    function* (transactionId) {
      const request = HttpClientRequest.get(
        `${context.origin}/v1/transactions/${encodeURIComponent(transactionId)}`,
        { headers: { authorization: context.authorization } }
      );
      const response = yield* context.http
        .execute(request, maximumProviderResponseBytes)
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
  const http = makeBoundedExternalHttpClient("wompi")(yield* HttpClient.HttpClient);
  const crypto = yield* Crypto.Crypto;
  const environment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
  const privateKeyValue = Redacted.value(yield* Config.redacted("WOMPI_PRIVATE_KEY"));
  const integrityValue = Redacted.value(yield* Config.redacted("WOMPI_INTEGRITY_SECRET"));
  if (!Schema.is(PrivateKey)(privateKeyValue) || !Schema.is(IntegritySecret)(integrityValue)) {
    return yield* Effect.die("Wompi billing credentials have an invalid shape");
  }
  const prefixes =
    environment === "sandbox"
      ? { privateKey: "prv_test_", integrity: "test_integrity_" }
      : { privateKey: "prv_prod_", integrity: "prod_integrity_" };
  if (
    !privateKeyValue.startsWith(prefixes.privateKey) ||
    !integrityValue.startsWith(prefixes.integrity)
  ) {
    return yield* Effect.die("Wompi billing credential prefixes do not match WOMPI_ENVIRONMENT");
  }
  const context = {
    http,
    crypto,
    integrityValue,
    origin: environment === "sandbox" ? sandboxOrigin : productionOrigin,
    authorization: `Bearer ${privateKeyValue}`,
  };
  return WompiBillingClient.of({
    environment,
    createTransaction: makeCreateTransaction(context),
    findTransaction: makeFindTransaction(context),
  });
});

export class WompiBillingClient extends Context.Service<
  WompiBillingClient,
  WompiBillingClientService
>()("@fidy/server/shell/subscription/wompi-billing-client/WompiBillingClient") {
  static readonly layer = Layer.effect(WompiBillingClient, loadBillingAdapter);
}
