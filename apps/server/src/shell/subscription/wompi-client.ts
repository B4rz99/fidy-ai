import { UnknownJsonString, jsonStringSchema } from "~/shell/schema-codecs/contract";
import {
  Config,
  Context,
  Crypto,
  Data,
  type DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import {
  BillingEmail,
  EndUserPolicyEvidence,
  PersonalDataAuthorizationEvidence,
  type WompiContractEvidenceSet,
  WompiSourceId,
} from "~/core/subscription/enrollment-model";
import type { OutboundHttpFailure, OutboundHttpResponse } from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
import { wompiCredentialPrefixes } from "~/shell/secret-material/operations";

const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const providerServerErrorStatusMinimum = 500;
const maximumAcceptanceTokenCharacters = 4096;

const WompiEnvironment = Schema.Literals(["sandbox", "production"]);
const PublicKey = Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u));
const AcceptanceToken = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumAcceptanceTokenCharacters)
);
const PresignedAcceptance = Schema.Struct({
  acceptance_token: AcceptanceToken,
  permalink: Schema.URLFromString,
});
const MerchantResponse = Schema.Struct({
  data: Schema.Struct({
    presigned_acceptance: PresignedAcceptance,
    presigned_personal_data_auth: PresignedAcceptance,
  }),
});
const AcceptanceClaims = Schema.Struct({
  permalink: Schema.URLFromString,
  file_hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32,128}$/u)),
});
const decodeAcceptanceClaims = Schema.decodeUnknownResult(jsonStringSchema(AcceptanceClaims));
const SourceResponse = Schema.Struct({
  data: Schema.Struct({
    id: WompiSourceId,
    status: Schema.Literals(["AVAILABLE", "DECLINED", "ERROR", "PENDING"]),
  }),
});
const SourceLookupResponse = Schema.Struct({
  data: Schema.Struct({
    id: WompiSourceId,
    status: Schema.Literal("AVAILABLE"),
    customer_email: BillingEmail,
  }),
});
const decodeMerchant = Schema.decodeUnknownResult(MerchantResponse);
const decodeSource = Schema.decodeUnknownResult(SourceResponse);
const decodeSourceLookup = Schema.decodeUnknownResult(SourceLookupResponse);
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);

/** Transient Wompi token obtained by the browser; this value must never be persisted or logged. */
export type WompiCardToken = string;

/** Fresh provider acceptances paired with the exact safe links and text displayed by Fidy. */
export type WompiContracts = Readonly<{
  publicKey: string;
  evidence: WompiContractEvidenceSet;
  endUserAcceptance: Redacted.Redacted<string>;
  personalDataAcceptance: Redacted.Redacted<string>;
}>;

export class WompiContractsUnavailable extends Data.TaggedError("WompiContractsUnavailable")<{}> {}

export class WompiSourceCreationFailed extends Data.TaggedError("WompiSourceCreationFailed")<{
  readonly certainty: "rejected" | "ambiguous";
}> {}

export class WompiSourceLookupFailed extends Data.TaggedError("WompiSourceLookupFailed")<{}> {}

export type WompiVerifiedSource = Readonly<{
  sourceId: WompiSourceId;
  billingEmail: BillingEmail;
}>;

export type WompiSourceResult =
  | Readonly<{ _tag: "Available"; sourceId: WompiSourceId }>
  | Readonly<{ _tag: "Refused" }>;

export type WompiEnrollmentClientService = Readonly<{
  publicKey: string;
  contracts: (observedAt: DateTime.Utc) => Effect.Effect<WompiContracts, WompiContractsUnavailable>;
  createPaymentSource: (input: {
    cardToken: Redacted.Redacted<WompiCardToken>;
    billingEmail: BillingEmail;
    contracts: WompiContracts;
  }) => Effect.Effect<WompiSourceResult, WompiSourceCreationFailed>;
  verifyPaymentSource: (
    sourceId: WompiSourceId
  ) => Effect.Effect<WompiVerifiedSource, WompiSourceLookupFailed>;
}>;

const responseJson = Effect.fn(function* (response: OutboundHttpResponse) {
  const decoded = decodeJson(new TextDecoder().decode(response.body));
  return Result.isSuccess(decoded)
    ? decoded.success
    : yield* Effect.fail("response-malformed" as const);
});

const digestText = Effect.fn(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);
  return Encoding.encodeHex(digest);
});

const acceptanceProviderContentHash = Effect.fn(function* (
  acceptanceToken: string,
  permalink: URL
) {
  const encodedClaims = acceptanceToken.split(".")[1];
  if (encodedClaims === undefined) return yield* Effect.fail("acceptance-claims" as const);
  const claimsText = Encoding.decodeBase64UrlString(encodedClaims);
  if (Result.isFailure(claimsText)) return yield* Effect.fail("acceptance-claims" as const);
  const claims = decodeAcceptanceClaims(claimsText.success);
  if (Result.isFailure(claims) || claims.success.permalink.href !== permalink.href) {
    return yield* Effect.fail("acceptance-claims" as const);
  }
  return claims.success.file_hash;
});

const contractEvidenceFields = Effect.fn(function* (
  input: Readonly<{
    permalink: URL;
    displayedText: string;
    acceptanceToken: string;
    observedAt: DateTime.Utc;
  }>
) {
  return {
    permalink: input.permalink,
    displayedText: input.displayedText,
    contentSha256: yield* digestText(input.displayedText),
    providerContentHash: yield* acceptanceProviderContentHash(
      input.acceptanceToken,
      input.permalink
    ),
    observedAt: input.observedAt,
  };
});

const SourceRequest = Schema.Struct({
  type: Schema.Literal("CARD"),
  token: Schema.String,
  customer_email: Schema.String,
  acceptance_token: Schema.String,
  accept_personal_auth: Schema.String,
});
const encodeSourceRequest = Schema.encodeSync(jsonStringSchema(SourceRequest));

const parseSourceResult = (
  body: unknown
): Effect.Effect<WompiSourceResult, WompiSourceCreationFailed> => {
  const decoded = decodeSource(body);
  if (Result.isFailure(decoded)) {
    return Effect.fail(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
  }
  switch (decoded.success.data.status) {
    case "AVAILABLE":
      return Effect.succeed<WompiSourceResult>({
        _tag: "Available",
        sourceId: decoded.success.data.id,
      });
    case "DECLINED":
    case "ERROR":
      return Effect.succeed<WompiSourceResult>({ _tag: "Refused" });
    case "PENDING":
      return Effect.fail(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
  }
};

const contractsFromMerchant = (
  merchant: typeof MerchantResponse.Type,
  publicKey: string,
  observedAt: DateTime.Utc
): Effect.Effect<WompiContracts, "acceptance-claims", Crypto.Crypto> =>
  Effect.all([
    contractEvidenceFields({
      permalink: merchant.data.presigned_acceptance.permalink,
      displayedText: "Acepto el reglamento de Wompi.",
      acceptanceToken: merchant.data.presigned_acceptance.acceptance_token,
      observedAt,
    }),
    contractEvidenceFields({
      permalink: merchant.data.presigned_personal_data_auth.permalink,
      displayedText: "Autorizo el tratamiento de datos personales de Wompi.",
      acceptanceToken: merchant.data.presigned_personal_data_auth.acceptance_token,
      observedAt,
    }),
  ]).pipe(
    Effect.map(([endUser, personalData]) => ({
      publicKey,
      evidence: {
        endUserPolicy: EndUserPolicyEvidence.make({ kind: "end-user-policy", ...endUser }),
        personalDataAuthorization: PersonalDataAuthorizationEvidence.make({
          kind: "personal-data-authorization",
          ...personalData,
        }),
      },
      endUserAcceptance: Redacted.make(merchant.data.presigned_acceptance.acceptance_token),
      personalDataAcceptance: Redacted.make(
        merchant.data.presigned_personal_data_auth.acceptance_token
      ),
    }))
  );

const makeContracts =
  ({
    outboundHttp,
    crypto,
    publicKey,
  }: Readonly<{
    outboundHttp: OutboundHttpService;
    crypto: Crypto.Crypto;
    publicKey: string;
  }>): WompiEnrollmentClientService["contracts"] =>
  (observedAt) =>
    outboundHttp.execute({ _tag: "WompiMerchant" }).pipe(
      Effect.timeout("10 seconds"),
      Effect.filterOrFail(
        (response) =>
          response.status >= successfulStatusMinimum &&
          response.status < successfulStatusMaximumExclusive,
        () => "provider-status" as const
      ),
      Effect.flatMap(responseJson),
      Effect.flatMap((body) =>
        Result.match(decodeMerchant(body), {
          onFailure: () => Effect.fail("provider-schema" as const),
          onSuccess: Effect.succeed,
        })
      ),
      Effect.flatMap((merchant) => contractsFromMerchant(merchant, publicKey, observedAt)),
      Effect.mapError(() => new WompiContractsUnavailable()),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.withSpan("Wompi.contracts", { attributes: { provider: "wompi" } })
    );

const makeVerifyPaymentSource =
  (outboundHttp: OutboundHttpService): WompiEnrollmentClientService["verifyPaymentSource"] =>
  (sourceId) =>
    outboundHttp.execute({ _tag: "WompiVerifyPaymentSource", sourceId }).pipe(
      Effect.timeout("10 seconds"),
      Effect.filterOrFail(
        (response) =>
          response.status >= successfulStatusMinimum &&
          response.status < successfulStatusMaximumExclusive,
        () => "provider-status" as const
      ),
      Effect.flatMap(responseJson),
      Effect.flatMap((body) =>
        Result.match(decodeSourceLookup(body), {
          onFailure: () => Effect.fail("provider-schema" as const),
          onSuccess: ({ data }) =>
            Effect.succeed({ sourceId: data.id, billingEmail: data.customer_email }),
        })
      ),
      Effect.mapError(() => new WompiSourceLookupFailed()),
      Effect.withSpan("Wompi.verifyPaymentSource", { attributes: { provider: "wompi" } })
    );

const sourceCreationTransportFailure = (
  failure: OutboundHttpFailure | { readonly _tag: "TimeoutError" }
): WompiSourceCreationFailed =>
  new WompiSourceCreationFailed({
    certainty:
      failure._tag === "OutboundHttpFailure" &&
      Option.exists(
        failure.responseStatus,
        (status) =>
          status < providerServerErrorStatusMinimum &&
          (status < successfulStatusMinimum || status >= successfulStatusMaximumExclusive)
      )
        ? "rejected"
        : "ambiguous",
  });

const makeCreatePaymentSource =
  (outboundHttp: OutboundHttpService): WompiEnrollmentClientService["createPaymentSource"] =>
  (input) =>
    outboundHttp
      .execute({
        _tag: "WompiCreatePaymentSource",
        body: encodeSourceRequest({
          type: "CARD",
          token: Redacted.value(input.cardToken),
          customer_email: input.billingEmail,
          acceptance_token: Redacted.value(input.contracts.endUserAcceptance),
          accept_personal_auth: Redacted.value(input.contracts.personalDataAcceptance),
        }),
      })
      .pipe(
        Effect.timeout("14 seconds"),
        Effect.mapError(sourceCreationTransportFailure),
        Effect.flatMap((response) => {
          const successful =
            response.status >= successfulStatusMinimum &&
            response.status < successfulStatusMaximumExclusive;
          if (successful) {
            return responseJson(response).pipe(
              Effect.mapError(() => new WompiSourceCreationFailed({ certainty: "ambiguous" }))
            );
          }
          return Effect.fail(
            new WompiSourceCreationFailed({
              certainty:
                response.status >= providerServerErrorStatusMinimum ? "ambiguous" : "rejected",
            })
          );
        }),
        Effect.flatMap(parseSourceResult),
        Effect.withSpan("Wompi.createPaymentSource", { attributes: { provider: "wompi" } })
      );

export class WompiEnrollmentClient extends Context.Service<
  WompiEnrollmentClient,
  WompiEnrollmentClientService
>()("@fidy/server/shell/subscription/wompi-client/WompiEnrollmentClient") {
  static readonly layer = Layer.effect(
    WompiEnrollmentClient,
    Effect.gen(function* () {
      const outboundHttp = yield* OutboundHttp;
      const crypto = yield* Crypto.Crypto;
      const environment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
      const prefixes = wompiCredentialPrefixes(environment);
      const publicKey = yield* Config.schema(
        PublicKey.check(Schema.isStartsWith(prefixes.publicKey)),
        "WOMPI_PUBLIC_KEY"
      );
      return WompiEnrollmentClient.of({
        publicKey,
        contracts: makeContracts({ outboundHttp, crypto, publicKey }),
        createPaymentSource: makeCreatePaymentSource(outboundHttp),
        verifyPaymentSource: makeVerifyPaymentSource(outboundHttp),
      });
    })
  );
}
