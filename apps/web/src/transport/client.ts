import {
  FidyApi,
  type FidyApiGroups,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
  TokenAuthorizationClientAnonymousLive,
  WebAuthApi,
  type WebAuthApiGroups,
} from "@fidy/server/client";
import { Context, Data, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AtomHttpApi } from "effect/unstable/reactivity";
import { browserHttpClientLayer } from "./browser-http-policy";

export type {
  CanonicalInput,
  CanonicalSuccess,
  CardEnrollmentType,
  CardPaymentSubmissionType,
  SubscriptionStatus,
} from "@fidy/server/client";
export {
  BackupRecoveryCode,
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  EmailAddress,
  EmailVerificationCode,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  DashboardCatalogEntry,
  DashboardEdit,
  maximumSplitWeight,
  minimumSplitWeight,
  SplitWeight,
  WidgetId,
  CreateManualPATPayload,
  IssuedPAT,
  ManualPATGrantInput,
  ManualPATRequestId,
  PATId,
  PATLifetimeDays,
  ActivePATList,
  ActivePATMetadata,
  ApprovedPATPairing,
  PATPairingId,
  PATPairingPublicCode,
  PATPairingReview,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  PriceId,
  BillingAttemptId,
  IanaTimeZone,
  PaymentRequestId,
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
  CardPaymentSubmission,
  TokenBearer,
  TokenShortId,
  buildPATDisclosure,
  countPATLabelCharacters,
  defaultPATLifetimeDays,
  patLifetimeDayOptions,
  patScopeCopy,
  recipientLabelLimit,
} from "@fidy/server/client";

/**
 * Supplies the substitute HTTP runtime for the derived browser client. Production uses Fetch;
 * callers may provide an equivalent HttpClient layer without replacing canonical operation
 * decoding. Authentication middleware and credentialed request initialization remain internal.
 */
export type FidyClientLayer = Layer.Layer<HttpClient.HttpClient>;

const canonicalHttpClientLayer = (
  apiOrigin: string,
  httpClient: FidyClientLayer
): FidyClientLayer =>
  Layer.merge(
    httpClient.pipe(browserHttpClientLayer("canonical", apiOrigin)),
    TokenAuthorizationClientAnonymousLive
  );

/** Receives the single browser-lifetime transition caused by a canonical 401 response. */
export type CanonicalAuthenticationObserver = Readonly<{
  onAuthenticationExpired: () => void;
}>;

const UnauthenticatedResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("unauthenticated") }),
});

const observeAuthenticationExpiration =
  (observer?: CanonicalAuthenticationObserver) =>
  <A, E, R>(response: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapError(response, (error) =>
      observer !== undefined && Schema.is(UnauthenticatedResponse)(error)
        ? Effect.sync(observer.onAuthenticationExpired)
        : Effect.void
    );

export type FidyClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/FidyClient",
  FidyApiGroups
>;

/**
 * Derives the sole browser transport from the server-owned canonical API declaration. `apiOrigin`
 * must be a credential-free HTTP(S) origin already validated by `parseApiOrigin`; it is used as the
 * request base URL without further normalization. Production callers use credentialed, no-store
 * Fetch with manual redirects; tests may replace only the underlying HttpClient layer. The client
 * refuses other origins and redirects, bounds request time and response bytes, retries GET/HEAD
 * transport failures once, and exposes transport or schema failures as sanitized defects while
 * retaining canonical request decoding and endpoint-declared failures.
 */
export const makeFidyClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer,
  observer?: CanonicalAuthenticationObserver
): FidyClient =>
  AtomHttpApi.Service<never>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: canonicalHttpClientLayer(apiOrigin, httpClient),
    transformResponse: observeAuthenticationExpiration(observer),
  });

/** Direct authentication transport, separate from product operations because it carries proofs. */
export type WebAuthClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/WebAuthClient",
  WebAuthApiGroups
>;

/**
 * Derives proof-bearing browser authentication calls from the server declaration. `apiOrigin` must
 * be a validated, credential-free HTTP(S) origin; `httpClient` may replace only the underlying
 * transport. Requests use credentialed, no-store Fetch with manual redirects, refuse other origins
 * and redirects, and apply the authentication deadline and response-byte budget. GET/HEAD transport
 * failures retry once; sanitized transport and schema failures remain defects.
 */
export const makeWebAuthClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer
): WebAuthClient =>
  AtomHttpApi.Service<never>()("@fidy/web/WebAuthClient", {
    api: WebAuthApi,
    baseUrl: apiOrigin,
    httpClient: httpClient.pipe(browserHttpClientLayer("web-auth", apiOrigin)),
  });

type EnrollmentApiClient = HttpApiClient.Client<SubscriptionEnrollmentApiGroups, never, never>;
class EnrollmentClientService extends Context.Service<
  EnrollmentClientService,
  EnrollmentApiClient
>()("@fidy/web/transport/client/EnrollmentClientService") {}

class EnrollmentClientDisposed extends Data.TaggedError("EnrollmentClientDisposed")<{}> {}

/**
 * Dedicated browser-only enrollment transport for one authentication lifetime. `dispose` revokes
 * new access synchronously, interrupts in-flight work, releases the ManagedRuntime, and is safe to
 * call repeatedly. The client stays outside canonical operations and PATs.
 */
export type SubscriptionEnrollmentClient = Readonly<{
  execute: <A, E>(use: (client: EnrollmentApiClient) => Effect.Effect<A, E>) => Promise<A>;
  dispose: () => Promise<void>;
}>;

/**
 * Derives exact enrollment calls with first-party cookies. `apiOrigin` must be a validated,
 * credential-free HTTP(S) origin; `httpClient` may replace only the underlying transport. Requests
 * use no-store Fetch with manual redirects, refuse other origins and redirects, and apply the
 * enrollment deadline and response-byte budget. GET/HEAD transport failures retry once; sanitized
 * transport and schema failures reject `execute`, while endpoint-declared failures retain their
 * generated semantics.
 */
export const makeSubscriptionEnrollmentClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer
): SubscriptionEnrollmentClient => {
  const live = Layer.effect(
    EnrollmentClientService,
    HttpApiClient.make(SubscriptionEnrollmentApi, { baseUrl: apiOrigin })
  ).pipe(Layer.provide(httpClient.pipe(browserHttpClientLayer("enrollment", apiOrigin))));
  const runtime = ManagedRuntime.make(live);
  let available = true;
  let disposal = Option.none<Promise<void>>();
  return {
    execute: (use) =>
      available
        ? runtime.runPromise(Effect.flatMap(EnrollmentClientService, use))
        : Effect.runPromise(Effect.fail(new EnrollmentClientDisposed())),
    dispose: () =>
      Option.match(disposal, {
        onNone: () => {
          available = false;
          const current = runtime.dispose();
          disposal = Option.some(current);
          return current;
        },
        onSome: (current) => current,
      }),
  };
};
