import {
  FidyApi,
  type FidyApiGroups,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
  TokenAuthorizationClientAnonymousLive,
  WebAuthApi,
  type WebAuthApiGroups,
} from "@fidy/server/client";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AtomHttpApi } from "effect/unstable/reactivity";

export type { CanonicalInput, CanonicalSuccess, CardEnrollmentType } from "@fidy/server/client";
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
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
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

const withCredentials = (httpClient: FidyClientLayer): FidyClientLayer =>
  httpClient.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }))
  );

const withBrowserTransportInvariants = (httpClient: FidyClientLayer): FidyClientLayer =>
  Layer.merge(withCredentials(httpClient), TokenAuthorizationClientAnonymousLive);

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
 * request base URL without further normalization. Production callers use credentialed Fetch; tests
 * may replace only the underlying HttpClient layer while keeping this same derived typed client and
 * canonical request decoding.
 */
export const makeFidyClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer,
  observer?: CanonicalAuthenticationObserver
): FidyClient =>
  AtomHttpApi.Service<never>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: withBrowserTransportInvariants(httpClient),
    transformResponse: observeAuthenticationExpiration(observer),
  });

/** Direct authentication transport, separate from product operations because it carries proofs. */
export type WebAuthClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/WebAuthClient",
  WebAuthApiGroups
>;

/** Derives browser authentication calls from the server declaration over the same Fetch runtime. */
export const makeWebAuthClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer
): WebAuthClient =>
  AtomHttpApi.Service<never>()("@fidy/web/WebAuthClient", {
    api: WebAuthApi,
    baseUrl: apiOrigin,
    httpClient: withCredentials(httpClient),
  });

type EnrollmentApiClient = HttpApiClient.Client<SubscriptionEnrollmentApiGroups, never, never>;
class EnrollmentClientService extends Context.Service<
  EnrollmentClientService,
  EnrollmentApiClient
>()("@fidy/web/transport/client/EnrollmentClientService") {}

/** Dedicated browser-only enrollment transport, kept outside canonical operations and PATs. */
export type SubscriptionEnrollmentClient = Readonly<{
  execute: <A, E>(use: (client: EnrollmentApiClient) => Effect.Effect<A, E>) => Promise<A>;
}>;

/** Derives exact enrollment calls with first-party cookies over the shared browser runtime. */
export const makeSubscriptionEnrollmentClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer
): SubscriptionEnrollmentClient => {
  const live = Layer.effect(
    EnrollmentClientService,
    HttpApiClient.make(SubscriptionEnrollmentApi, { baseUrl: apiOrigin })
  ).pipe(Layer.provide(withCredentials(httpClient)));
  const runtime = ManagedRuntime.make(live);
  return {
    execute: (use) => runtime.runPromise(Effect.flatMap(EnrollmentClientService, use)),
  };
};
