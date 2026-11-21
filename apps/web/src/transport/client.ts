import { type BrowserClientOptions, browserClientLayer } from "./browser-client-layer";
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
import type { HttpClient } from "effect/http";
import { HttpApiClient, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import { AtomHttpApi } from "effect/reactivity";
import { observeBrowserDecode } from "./browser-defects";

export type {
  FidyApiGroups,
  LayoutNodeFor,
  AuthenticationProvider,
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
  fidyWhatsAppUrl,
  TransactionId,
  ReviewCommand,
  ReviewDraft,
  TransactionQueryValues,
} from "@fidy/server/client";

export {
  ConnectionAttemptReference,
  ConnectionContinuationReview,
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionListQuery,
  OAuthConnectionMetadata,
  OAuthReauthenticationRequired,
  OAuthUnauthenticated,
  OAuthRequestId,
  OAuthReview,
  OAuthReviewChoice,
} from "@fidy/server/client";

export {
  BudgetMonth,
  Currency,
  AtomicBatchCallId,
  AtomicBatchRejected,
  maximumAtomicBatchCalls,
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
  PATActivity,
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

export type FidyClientLayer = Layer.Layer<HttpClient.HttpClient>;

export type CanonicalAuthenticationObserver = Readonly<{
  onAuthenticationExpired: () => void;
}>;

const UnauthenticatedResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("unauthenticated") }),
});

const observeAuthenticationExpiration =
  (observer?: CanonicalAuthenticationObserver) =>
  <A, E, R>(response: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapError(observeBrowserDecode(response), (error) =>
      observer !== undefined && Schema.is(UnauthenticatedResponse)(error)
        ? Effect.sync(observer.onAuthenticationExpired)
        : Effect.void
    );

type FidyClientOptions =
  | BrowserClientOptions
  | (BrowserClientOptions & Readonly<{ observer: CanonicalAuthenticationObserver }>);

export type FidyClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/FidyClient",
  FidyApiGroups
>;

export const makeFidyClient = (options: FidyClientOptions): FidyClient =>
  AtomHttpApi.Service<never>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: options.apiOrigin,
    httpClient: Layer.merge(
      browserClientLayer({ ...options, boundary: "canonical" }),
      TokenAuthorizationClientAnonymousLive
    ),
    transformResponse: observeAuthenticationExpiration(
      "observer" in options ? options.observer : undefined
    ),
  });

export type WebAuthClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/WebAuthClient",
  WebAuthApiGroups
>;

export type WebAuthSuccess<
  Group extends WebAuthApiGroups["identifier"],
  Endpoint extends HttpApiGroup.EndpointsWithIdentifier<WebAuthApiGroups, Group>["identifier"],
> = HttpApiClient.SuccessType<
  HttpApiEndpoint.Success<
    HttpApiEndpoint.WithIdentifier<
      HttpApiGroup.EndpointsWithIdentifier<WebAuthApiGroups, Group>,
      Endpoint
    >
  >
>;

export const makeWebAuthClient = (options: BrowserClientOptions): WebAuthClient =>
  AtomHttpApi.Service<never>()("@fidy/web/WebAuthClient", {
    api: WebAuthApi,
    baseUrl: options.apiOrigin,
    httpClient: browserClientLayer({ ...options, boundary: "web-auth" }),
    transformResponse: observeBrowserDecode,
  });

type EnrollmentApiClient = HttpApiClient.Client<SubscriptionEnrollmentApiGroups, never, never>;

class EnrollmentClientService extends Context.Service<
  EnrollmentClientService,
  EnrollmentApiClient
>()("@fidy/web/transport/client/EnrollmentClientService") {
  static readonly make = (
    apiOrigin: string
  ): Effect.Effect<EnrollmentApiClient, never, HttpClient.HttpClient> =>
    HttpApiClient.make(SubscriptionEnrollmentApi, {
      baseUrl: apiOrigin,
      transformResponse: observeBrowserDecode,
    });

  static readonly layer = (
    apiOrigin: string
  ): Layer.Layer<EnrollmentClientService, never, HttpClient.HttpClient> =>
    Layer.effect(this, this.make(apiOrigin));
}

class EnrollmentClientDisposed extends Data.TaggedError("EnrollmentClientDisposed")<{}> {}

export type SubscriptionEnrollmentClient = Readonly<{
  signal: AbortSignal;
  execute: <A, E>(
    use: (client: EnrollmentApiClient) => Effect.Effect<A, E>,
    options?: Partial<Readonly<{ signal: AbortSignal }>>
  ) => Promise<A>;
  dispose: () => Promise<void>;
}>;

export const makeSubscriptionEnrollmentClient = (
  options: BrowserClientOptions
): SubscriptionEnrollmentClient => {
  const live = EnrollmentClientService.layer(options.apiOrigin).pipe(
    Layer.provide(browserClientLayer({ ...options, boundary: "enrollment" }))
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
        : Promise.reject(new EnrollmentClientDisposed()),
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

export { RecurringDigestReport, RecurringDigestReportParams } from "@fidy/server/client";

export { ProviderHandoffSearch } from "@fidy/server/client";

export { ManualPATReauthenticationRequired, User } from "@fidy/server/client";

export { Budget, Category, BudgetStatusReport } from "@fidy/server/client";

export type {
  BrowserSessionBinding,
  ProcessingConsentStatus,
  ProcessingAuthorization,
  PrivacyTransactionPage,
} from "@fidy/server/client";

export {
  RecurringCommand,
  RecurringEdit,
  RecurringPlanInput,
  RecurringFilters,
  RecurringPlanId,
  RecurringDate,
  RecurringMonth,
} from "@fidy/server/client";

export type { InitialTransactionPage } from "@fidy/server/browser-bootstrap";

export { BrowserSessionBinding as BrowserSessionBindingSchema } from "@fidy/server/browser-bootstrap";
