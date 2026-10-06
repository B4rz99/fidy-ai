import {
  FidyApi,
  type FidyApiGroups,
  HostedTurnApi,
  type HostedTurnApiGroups,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
  HostedTurnProposal,
  HostedTurnReceipt,
  HostedTurnRequest,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
  TokenAuthorizationClientAnonymousLive,
  WebAuthApi,
  type WebAuthApiGroups,
} from "@fidy/server/client";
import { Context, Data, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AtomHttpApi } from "effect/reactivity";
import { browserHttpClientLayer } from "./browser-http-policy";

export type {
  CanonicalInput,
  CanonicalSuccess,
  PaymentEnrollmentType,
  PaymentSubmissionType,
  SubscriptionStatus,
  EnrollmentMethod,
  EnrollmentAvailability,
  DaviplataOtpPolicy,
  SubmitPaymentEnrollmentPayload,
} from "@fidy/server/client";
export {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionListQuery,
  OAuthConnectionMetadata,
  OAuthRequestId,
  OAuthReview,
  OAuthReviewChoice,
} from "@fidy/server/client";
export {
  BackupRecoveryCode,
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  EmailAddress,
  EmailVerificationCode,
  EmailVerificationInvalidApi,
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
  PaymentEnrollment,
  EnrollmentDecisions,
  PaymentEnrollmentId,
  PaymentSubmission,
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

export {
  HostedTurnRequest,
  HostedTurnReceipt,
  HostedTurnProposal,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
};

/** Dedicated browser-only reply-and-receipt channel; never a canonical tool operation. */
export type HostedTurnClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/HostedTurnClient",
  HostedTurnApiGroups
>;

type BrowserClientOptions =
  | Readonly<{ apiOrigin: string }>
  | Readonly<{ apiOrigin: string; httpClient: FidyClientLayer }>;

type FidyClientOptions =
  | BrowserClientOptions
  | (BrowserClientOptions & Readonly<{ observer: CanonicalAuthenticationObserver }>);

const browserClientLayer = (options: BrowserClientOptions): FidyClientLayer =>
  "httpClient" in options ? options.httpClient : FetchHttpClient.layer;

export const makeHostedTurnClient = (options: BrowserClientOptions): HostedTurnClient =>
  AtomHttpApi.Service<never>()("@fidy/web/HostedTurnClient", {
    api: HostedTurnApi,
    baseUrl: options.apiOrigin,
    httpClient: browserClientLayer(options).pipe(
      browserHttpClientLayer("hosted-turn", options.apiOrigin)
    ),
  });

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
export const makeFidyClient = (options: FidyClientOptions): FidyClient =>
  AtomHttpApi.Service<never>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: options.apiOrigin,
    httpClient: canonicalHttpClientLayer(options.apiOrigin, browserClientLayer(options)),
    transformResponse: observeAuthenticationExpiration(
      "observer" in options ? options.observer : undefined
    ),
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
export const makeWebAuthClient = (options: BrowserClientOptions): WebAuthClient =>
  AtomHttpApi.Service<never>()("@fidy/web/WebAuthClient", {
    api: WebAuthApi,
    baseUrl: options.apiOrigin,
    httpClient: browserClientLayer(options).pipe(
      browserHttpClientLayer("web-auth", options.apiOrigin)
    ),
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
  /** Aborted synchronously on disposal, including while a mounted provider challenge is idle. */
  signal: AbortSignal;
  execute: <A, E>(
    use: (client: EnrollmentApiClient) => Effect.Effect<A, E>,
    options?: Partial<Readonly<{ signal: AbortSignal }>>
  ) => Promise<A>;
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
  options: BrowserClientOptions
): SubscriptionEnrollmentClient => {
  const live = Layer.effect(
    EnrollmentClientService,
    HttpApiClient.make(SubscriptionEnrollmentApi, { baseUrl: options.apiOrigin })
  ).pipe(
    Layer.provide(
      browserClientLayer(options).pipe(browserHttpClientLayer("enrollment", options.apiOrigin))
    )
  );
  const runtime = ManagedRuntime.make(live);
  const lifetime = new AbortController();
  let available = true;
  let disposal = Option.none<Promise<void>>();
  return {
    signal: lifetime.signal,
    execute: (use, execution) =>
      available
        ? runtime.runPromise(Effect.flatMap(EnrollmentClientService, use), execution)
        : Effect.runPromise(Effect.fail(new EnrollmentClientDisposed())),
    dispose: () =>
      Option.match(disposal, {
        onNone: () => {
          available = false;
          lifetime.abort();
          const current = runtime.dispose();
          disposal = Option.some(current);
          return current;
        },
        onSome: (current) => current,
      }),
  };
};
