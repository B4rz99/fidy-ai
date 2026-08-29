import { BunHttpServer, BunServices } from "@effect/platform-bun";
import {
  type Config,
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  type Etag,
  FetchHttpClient,
  type HttpClient,
  type HttpClientError,
  type HttpPlatform,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { Migrator, SqlClient, SqlError } from "effect/unstable/sql";
import {
  BillingEmail,
  EndUserPolicyEvidence,
  PersonalDataAuthorizationEvidence,
  WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { type TokenBearer } from "~/core/tokens/model";
import { HostedInference } from "~/shell/agent/hosted-inference";
import { ConversationCompactionInference } from "~/shell/transcript/conversation-compaction-inference";
import { makeTokenAuthorizationClientLive } from "~/shell/_shared/authz";
import { okStatus } from "~/shell/_shared/http-status";
import type {
  ConsentRequired,
  NotFound,
  PaywallRequired,
  ScopeMissing,
  Unauthenticated,
  UserActionRequired,
  ValidationFailed,
} from "~/shell/_shared/errors";
import { FidyApi } from "~/shell/api";
import { maximumPublicRequestBodySizeBytes } from "~/shell/runtime";
import type { MemoryCapacityExceededApi } from "~/shell/memory/errors";
import type { AtomicBatchRejected } from "~/shell/operations/operations";
import {
  WompiEnrollmentClient,
  WompiSourceCreationFailed,
} from "~/shell/subscription/wompi-client";
import {
  KapsoClient,
  type KapsoClientService,
  KapsoSendFailed,
} from "~/shell/channels/whatsapp/kapso-client";
import { WhatsAppProviderMessageId } from "~/shell/channels/whatsapp/model";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { defaultPatBearer } from "./identity-fixtures";
import { TestPublicNamespace } from "./test-config";
import { HttpLive } from "~/shell/http";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import type { Telemetry } from "~/shell/observability/telemetry";
import { TelemetryEnvelopeRecording } from "~/shell/observability/envelope-recorder";
import type { SupportAccessVerifier } from "~/shell/recovery/access";
import { SupportRecoveryTestAccess } from "~/shell/recovery/routes";

/**
 * Derives the typed client from the ambient HttpClient, which the test server
 * layer points at whatever port the harness bound. Every request presents one
 * opaque TokenBearer bearer; no client API accepts a UserId as authentication.
 */
const derivedApiClient = HttpApiClient.make(FidyApi);

/** The derived client's shape, for tests holding one per User rather than the service. */
export type ApiClient = Effect.Success<typeof derivedApiClient>;

/** Every declared or transport failure shared by canonical test probes. */
export type ApiCallFailure =
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | ConsentRequired
  | NotFound
  | PaywallRequired
  | ScopeMissing
  | Unauthenticated
  | UserActionRequired
  | ValidationFailed
  | MemoryCapacityExceededApi
  | AtomicBatchRejected;

/** Builds a client service whose bearer is supplied through the declared middleware. */
export const makeApiClientLive = <Id>({
  bearer,
  tag,
}: {
  readonly bearer: TokenBearer;
  readonly tag: Context.Key<Id, ApiClient>;
}): Layer.Layer<Id, never, HttpClient.HttpClient> =>
  Layer.effect(tag, derivedApiClient).pipe(Layer.provide(makeTokenAuthorizationClientLive(bearer)));

/** The same TokenBearer bearer for tests that speak raw HTTP. */
export const headersFor = (bearer: TokenBearer): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
});

/** The derived typed client as a service, so tests can just yield it. */
export class ApiHarnessClient extends Context.Service<ApiHarnessClient, ApiClient>()(
  "@fidy/server/shell/testing/api-harness/ApiHarnessClient"
) {}

/** Controls and observes the fake provider at the public HTTP test seam. */
export class ApiHarnessKapsoControl extends Context.Service<
  ApiHarnessKapsoControl,
  {
    readonly callCount: Effect.Effect<number>;
    readonly failNextAfterAcceptance: Effect.Effect<void>;
    readonly reset: Effect.Effect<void>;
  }
>()("@fidy/server/shell/testing/api-harness/ApiHarnessKapsoControl") {}

const TestKapsoClient = Layer.effectContext(
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const failNext = yield* Ref.make(false);
    const client: KapsoClientService = {
      sendText: () =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (count) => count + 1);
          if (yield* Ref.getAndSet(failNext, false)) {
            return yield* new KapsoSendFailed({
              safeReason: "provider_unavailable",
              deliveryCertainty: "ambiguous",
              automaticRetry: false,
              responseStatus: Option.none(),
            });
          }
          return {
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.test-outbound"),
            },
            sentAt: yield* DateTime.now,
            responseStatus: TelemetryHttpStatus.make(okStatus),
          };
        }),
    };
    const control = ApiHarnessKapsoControl.of({
      callCount: Ref.get(calls),
      failNextAfterAcceptance: Ref.set(failNext, true),
      reset: Effect.all([Ref.set(calls, 0), Ref.set(failNext, false)], {
        discard: true,
      }),
    });
    return Context.empty().pipe(
      Context.add(KapsoClient, client),
      Context.add(ApiHarnessKapsoControl, control)
    );
  })
);

/**
 * The API seam: the real handler stack served over a real socket against a
 * real Postgres (DATABASE_URL), exercised through the derived typed client.
 * Tests run under Bun (vitest on the Bun runtime), matching the production
 * entrypoint, so the socket is a Bun HTTP server. The layer also exposes the
 * test HttpClient, already pointed at the server, for raw HTTP checks. Runtime
 * retention workers are excluded; their deterministic seams have dedicated tests.
 */
const MemoryInferenceTest = Layer.succeed(
  HostedInference,
  HostedInference.of({
    countText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
    countTranscript: (messages) => Effect.succeed(messages.length),
    prepareText: () => Effect.die("Hosted text inference is outside the API harness"),
    validateText: () => Effect.die("Hosted text inference is outside the API harness"),
    prepareStructured: () => Effect.die("Hosted structured inference is outside the API harness"),
  })
);

const BaselineCompactionInference = Layer.succeed(ConversationCompactionInference, {
  countText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
  countTranscript: () => Effect.succeed(0),
  generate: () => Effect.die("Compaction is below threshold in the API harness"),
});

const sha256HexCharacters = 64;
const wompiSourceIdFromText = Schema.decodeSync(
  Schema.FiniteFromString.pipe(Schema.decodeTo(WompiSourceId))
);
const createdWompiSourceId = wompiSourceIdFromText("3891");
const reconciledWompiSourceId = wompiSourceIdFromText("4991");

export const TestWompiEnrollmentClient = Layer.succeed(WompiEnrollmentClient, {
  publicKey: "pub_test_api_harness",
  contracts: (observedAt) => {
    const endUserPermalink = new URL("https://wompi.example/end-user.pdf");
    const personalDataPermalink = new URL("https://wompi.example/personal-data.pdf");
    return Effect.succeed({
      publicKey: "pub_test_api_harness",
      evidence: {
        endUserPolicy: EndUserPolicyEvidence.make({
          kind: "end-user-policy",
          permalink: endUserPermalink,
          displayedText: "Acepto el reglamento de Wompi.",
          contentSha256: "0".repeat(sha256HexCharacters),
          providerContentHash: "2".repeat(sha256HexCharacters),
          observedAt,
        }),
        personalDataAuthorization: PersonalDataAuthorizationEvidence.make({
          kind: "personal-data-authorization",
          permalink: personalDataPermalink,
          displayedText: "Autorizo el tratamiento de datos personales de Wompi.",
          contentSha256: "1".repeat(sha256HexCharacters),
          providerContentHash: "3".repeat(sha256HexCharacters),
          observedAt,
        }),
      },
      endUserAcceptance: Redacted.make("api-harness-end-user-acceptance"),
      personalDataAcceptance: Redacted.make("api-harness-personal-data-acceptance"),
    });
  },
  createPaymentSource: ({ cardToken }) => {
    const token = Redacted.value(cardToken);
    if (token === "tok_test_declined") return Effect.succeed({ _tag: "Refused" });
    if (token === "tok_test_ambiguous") {
      return Effect.fail(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
    }
    if (token === "tok_test_rejected") {
      return Effect.fail(new WompiSourceCreationFailed({ certainty: "rejected" }));
    }
    return Effect.succeed({ _tag: "Available", sourceId: createdWompiSourceId });
  },
  verifyPaymentSource: (sourceId) =>
    Effect.succeed({
      sourceId,
      billingEmail: BillingEmail.make(
        sourceId === reconciledWompiSourceId ? "outcome@example.com" : "wrong@example.com"
      ),
    }),
});

const BoundedBunHttpServerTest = HttpServer.layerTestClient.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))
    )
  ),
  Layer.provideMerge(
    BunHttpServer.layer({ port: 0, maxRequestBodySize: maximumPublicRequestBodySizeBytes })
  )
);

type SupportAccessApiHarnessOutput =
  | ApiHarnessClient
  | ApiHarnessKapsoControl
  | ConversationCompactionInference
  | Etag.Generator
  | HostedInference
  | HttpClient.HttpClient
  | HttpPlatform.HttpPlatform
  | HttpServer.HttpServer
  | KapsoClient
  | MigrationSqlClient
  | PgClient
  | WompiEnrollmentClient
  | SqlClient.SqlClient
  | BunServices.BunServices;
type SupportAccessApiHarnessError =
  | Config.ConfigError
  | Migrator.MigrationError
  | SqlError.SqlError;
type SupportAccessApiHarness = Layer.Layer<
  SupportAccessApiHarnessOutput,
  SupportAccessApiHarnessError,
  Telemetry
>;
type SupportAccessApiHarnessLive = Layer.Layer<
  SupportAccessApiHarnessOutput,
  SupportAccessApiHarnessError
>;

const makeApiHarnessBase = (access: Layer.Layer<SupportAccessVerifier>): SupportAccessApiHarness =>
  makeApiClientLive({
    tag: ApiHarnessClient,
    bearer: defaultPatBearer,
  }).pipe(
    Layer.provideMerge(HttpLive.pipe(Layer.provide(MigratorLive), Layer.provide(access))),
    Layer.provideMerge(TestKapsoClient),
    Layer.provideMerge(MemoryInferenceTest),
    Layer.provideMerge(BaselineCompactionInference),
    Layer.provideMerge(TestWompiEnrollmentClient),
    Layer.provideMerge(makeDevelopmentSeedLive(defaultPatBearer)),
    Layer.provideMerge(BoundedBunHttpServerTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(MigrationSqlClient.layer),
    Layer.provideMerge(PgLive),
    Layer.provideMerge(TestPublicNamespace)
  );

const ApiHarnessBase = makeApiHarnessBase(SupportRecoveryTestAccess);

/** API test stack with a caller-supplied Access verifier, for production-verifier boundary tests. */
export const makeApiHarnessWithSupportAccess = (
  access: Layer.Layer<SupportAccessVerifier>
): SupportAccessApiHarnessLive => makeApiHarnessBase(access).pipe(Layer.provide(TelemetryDisabled));

/** The ordinary API test stack, with observability fully disabled and no SDK transport. */
export const ApiHarness = ApiHarnessBase.pipe(Layer.provide(TelemetryDisabled));

const AcceptancePublicNamespace = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromEnv({
      env: {
        PUBLIC_WEB_ORIGIN: "https://127.0.0.1:4173",
        PUBLIC_API_ORIGIN: "https://127.0.0.1:4174",
        INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
        KAPSO_WEBHOOK_SECRET: "test-webhook-secret-32-characters",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
      },
    }),
    ConfigProvider.fromEnv()
  )
);

/** Real handler/PostgreSQL stack on the TLS socket used by the built-browser acceptance runner. */
export const makeBrowserLoginPairingAcceptanceServer = ({
  certificate,
  privateKey,
}: {
  readonly certificate: Bun.BunFile;
  readonly privateKey: Bun.BunFile;
}): Layer.Layer<never, Config.ConfigError | Migrator.MigrationError | SqlError.SqlError> =>
  HttpLive.pipe(
    Layer.provide(MigratorLive),
    Layer.provide(SupportRecoveryTestAccess),
    Layer.provide(TestKapsoClient),
    Layer.provide(MemoryInferenceTest),
    Layer.provide(BaselineCompactionInference),
    Layer.provide(TestWompiEnrollmentClient),
    Layer.provide(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: 4174,
        maxRequestBodySize: maximumPublicRequestBodySizeBytes,
        tls: { cert: certificate, key: privateKey },
      })
    ),
    Layer.provide(BunServices.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(MigrationSqlClient.layer),
    Layer.provide(PgLive),
    Layer.provide(AcceptancePublicNamespace),
    Layer.provide(TelemetryDisabled)
  );

/** The API seam with exact serialized telemetry exposed for observability behavior tests. */
export const ApiTelemetryHarness = Layer.merge(
  ApiHarnessBase.pipe(Layer.provide(TelemetryEnvelopeRecording)),
  TelemetryEnvelopeRecording
);
