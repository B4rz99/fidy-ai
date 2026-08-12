import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, DateTime, Effect, Layer, Option, Ref, type Schema } from "effect";
import { type HttpClient, type HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { type AgentBearerToken } from "~/core/tokens/model";
import { HostedInference } from "~/shell/agent/hosted-inference";
import { makeAgentAuthorizationClientLive } from "~/shell/_shared/authz";
import { okStatus } from "~/shell/_shared/http-status";
import type {
  ConsentRequired,
  NotFound,
  PaywallRequired,
  ScopeMissing,
  Unauthenticated,
  ValidationFailed,
} from "~/shell/_shared/errors";
import { FidyApi } from "~/shell/api";
import type { MemoryCapacityExceededApi } from "~/shell/memory/errors";
import type { AtomicBatchRejected } from "~/shell/operations/operations";
import {
  KapsoClient,
  type KapsoClientService,
  KapsoSendFailed,
} from "~/shell/channels/whatsapp/kapso-client";
import { WhatsAppProviderMessageId } from "~/shell/channels/whatsapp/model";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { defaultAgentBearer } from "./identity-fixtures";
import { TestPublicNamespace } from "./test-config";
import { HttpLive } from "~/shell/http";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { TelemetryEnvelopeRecording } from "~/shell/observability/envelope-recorder";

/**
 * Derives the typed client from the ambient HttpClient, which the test server
 * layer points at whatever port the harness bound. Every request presents one
 * opaque AgentToken bearer; no client API accepts a UserId as authentication.
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
  | ValidationFailed
  | MemoryCapacityExceededApi
  | AtomicBatchRejected;

/** Builds a client service whose bearer is supplied through the declared middleware. */
export const makeApiClientLive = <Id>({
  bearer,
  tag,
}: {
  readonly bearer: AgentBearerToken;
  readonly tag: Context.Key<Id, ApiClient>;
}): Layer.Layer<Id, never, HttpClient.HttpClient> =>
  Layer.effect(tag, derivedApiClient).pipe(Layer.provide(makeAgentAuthorizationClientLive(bearer)));

/** The same AgentToken bearer for tests that speak raw HTTP. */
export const headersFor = (bearer: AgentBearerToken): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
});

/** The derived typed client as a service, so tests can just yield it. */
export class ApiHarnessClient extends Context.Service<ApiHarnessClient, ApiClient>()(
  "fidy-ai/shell/testing/api-harness/ApiHarnessClient"
) {}

/** Controls and observes the fake provider at the public HTTP test seam. */
export class ApiHarnessKapsoControl extends Context.Service<
  ApiHarnessKapsoControl,
  {
    readonly callCount: Effect.Effect<number>;
    readonly failNextAfterAcceptance: Effect.Effect<void>;
    readonly reset: Effect.Effect<void>;
  }
>()("fidy-ai/shell/testing/api-harness/ApiHarnessKapsoControl") {}

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
    countMemoryText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
    prepareText: () => Effect.die("Hosted text inference is outside the API harness"),
    validateText: () => Effect.die("Hosted text inference is outside the API harness"),
    executeText: () => Effect.die("Hosted text inference is outside the API harness"),
    recoverText: () => Effect.die("Hosted text inference is outside the API harness"),
    discardText: () => Effect.die("Hosted text inference is outside the API harness"),
    prepareStructured: () => Effect.die("Hosted structured inference is outside the API harness"),
    executeStructured: () => Effect.die("Hosted structured inference is outside the API harness"),
    discardStructured: () => Effect.die("Hosted structured inference is outside the API harness"),
  })
);

const ApiHarnessBase = makeApiClientLive({
  tag: ApiHarnessClient,
  bearer: defaultAgentBearer,
}).pipe(
  Layer.provideMerge(HttpLive.pipe(Layer.provide(MigratorLive))),
  Layer.provideMerge(TestKapsoClient),
  Layer.provideMerge(MemoryInferenceTest),
  Layer.provideMerge(makeDevelopmentSeedLive(defaultAgentBearer)),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(TestPublicNamespace)
);

/** The ordinary API test stack, with observability fully disabled and no SDK transport. */
export const ApiHarness = ApiHarnessBase.pipe(Layer.provide(TelemetryDisabled));

/** The API seam with exact serialized telemetry exposed for observability behavior tests. */
export const ApiTelemetryHarness = Layer.merge(
  ApiHarnessBase.pipe(Layer.provide(TelemetryEnvelopeRecording)),
  TelemetryEnvelopeRecording
);
