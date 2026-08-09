import { BunHttpServer, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  MutableRef,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { type Response as AiResponse, LanguageModel } from "effect/unstable/ai";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { type ConsentRecord, PendingConsentExchangeId } from "~/core/consent/model";
import type { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { AgentBearerToken, AgentTokenScopes, getAgentTokenShortId } from "~/core/tokens/model";
import { AgentTokenId } from "~/core/tokens/reference";
import { renewAgentTokenIdleExpiry } from "~/core/tokens/rules";
import { hashAgentBearer } from "~/shell/_shared/authz";
import { categoryIds } from "~/core/categories/taxonomy";
import { AgentService } from "~/shell/agent/agent-service";
import {
  KapsoClient,
  type KapsoClientService,
  makeKapsoClientService,
} from "~/shell/channels/whatsapp/kapso-client";
import { WhatsAppProviderMessageId } from "~/shell/channels/whatsapp/model";
import { WhatsAppWorkerLive } from "~/shell/channels/whatsapp/worker";
import { processDueConsentDisclosureDelivery } from "~/shell/channels/whatsapp/disclosure-delivery";
import {
  DisclosureDeliveryAttemptId,
  DisclosureDeliveryCorrelationToken,
  DisclosureDeliveryFailureReason,
} from "~/shell/channels/whatsapp/disclosure-model";
import { findPendingConsentExchange, observeConsentRecords } from "~/shell/consent/repo";
import { MigrationSqlClient, MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { findWhatsAppCaller } from "~/shell/identity/repo";
import { upsertAgentToken } from "~/shell/tokens/repo";
import { HttpLive } from "~/shell/http";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { type ApiClient, makeApiClientLive } from "./api-harness";
import { defaultAgentBearer } from "./identity-fixtures";
import { makeLanguageModelFinishPart } from "./language-model-fixtures";
import { TestPublicNamespace } from "./test-config";

export type WhatsAppAcceptanceDeliveryMode = "bsuid" | "sandbox-phone";
/** Deterministic fake-provider outcome consumed by acceptance sends in configured order. */
export type WhatsAppAcceptanceKapsoOutcome =
  | "accepted"
  | "ambiguous"
  | "non-retryable-rejection"
  | "rejected";

/** One synthetic Kapso HTTP request retained only in memory for acceptance assertions. */
export type WhatsAppAcceptanceKapsoRequest = Readonly<{
  readonly url: string;
  readonly body: Schema.Json;
  readonly outcome: Readonly<{
    readonly providerMessageId: WhatsAppProviderMessageId;
  }>;
}>;

/**
 * Controls the recording Kapso transport below the production serializer. `requests` returns every
 * outbound JSON body since `reset`; synthetic provider-message numbering remains process-unique.
 * `sandbox-phone` serializes a phone `to`, while `bsuid` serializes a BSUID `recipient`.
 */
export class WhatsAppAcceptanceKapsoControl extends Context.Service<
  WhatsAppAcceptanceKapsoControl,
  {
    readonly requests: Effect.Effect<ReadonlyArray<WhatsAppAcceptanceKapsoRequest>>;
    readonly reset: Effect.Effect<void>;
    readonly setDeliveryMode: (mode: WhatsAppAcceptanceDeliveryMode) => Effect.Effect<void>;
    readonly setOutcomes: (
      outcomes: ReadonlyArray<WhatsAppAcceptanceKapsoOutcome>
    ) => Effect.Effect<void>;
  }
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceKapsoControl") {}

const AcceptanceDisclosureState = Schema.Struct({
  attemptId: DisclosureDeliveryAttemptId,
  state: Schema.Literals([
    "claimed",
    "started",
    "reconciliation-required",
    "retry-scheduled",
    "delivered",
    "definitively-failed",
    "retry-exhausted",
  ]),
  reason: Schema.OptionFromNullOr(DisclosureDeliveryFailureReason),
  attemptNumber: Schema.Int,
});
type AcceptanceDisclosureStateValue = typeof AcceptanceDisclosureState.Type & {
  readonly correlationToken: DisclosureDeliveryCorrelationToken;
};

const AcceptanceDisclosureAttempt = Schema.Struct({
  attemptId: DisclosureDeliveryAttemptId,
  exchangeId: PendingConsentExchangeId,
});
const AcceptanceDisclosureFailureMetadata = Schema.Struct({
  reason: DisclosureDeliveryFailureReason,
  certainty: Schema.Literals(["rejected", "ambiguous"]),
});

/** Acceptance-only observation and public-module control for disclosure recovery. */
export class WhatsAppAcceptanceDisclosureControl extends Context.Service<
  WhatsAppAcceptanceDisclosureControl,
  {
    readonly find: (caller: WhatsAppCallerReference) => Effect.Effect<
      Option.Option<{
        readonly exchangeId: PendingConsentExchangeId;
        readonly lifecycle: "AwaitingDecision" | "AwaitingDisclosureDelivery";
        readonly state: Option.Option<AcceptanceDisclosureStateValue>;
      }>
    >;
    readonly findAttemptByCorrelation: (
      token: DisclosureDeliveryCorrelationToken
    ) => Effect.Effect<Option.Option<typeof AcceptanceDisclosureAttempt.Type>>;
    readonly failureMetadata: (
      attemptId: DisclosureDeliveryAttemptId
    ) => Effect.Effect<Option.Option<typeof AcceptanceDisclosureFailureMetadata.Type>>;
    readonly runtimeHasDirectDeliveryUpdate: Effect.Effect<boolean>;
    readonly processDue: (now: DateTime.Utc) => Effect.Effect<boolean>;
  }
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceDisclosureControl") {}

/** Authenticated public canonical API client for the seeded acceptance User. */
export class WhatsAppAcceptanceApiClient extends Context.Service<
  WhatsAppAcceptanceApiClient,
  ApiClient
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceApiClient") {}

const acceptanceProbeCredentials = {
  "WA-A04": {
    bearer: AgentBearerToken.make("fin_obsa0401_0123456789abcdefghijklmnopqrstuvwxyzABCD"),
    tokenId: AgentTokenId.make("f1d1a000-0000-4000-8000-000000001214"),
    tag: Context.Service<ApiClient>(
      "fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceA04ApiClient"
    ),
  },
  "WA-A05": {
    bearer: AgentBearerToken.make("fin_obsa0501_0123456789abcdefghijklmnopqrstuvwxyzABCD"),
    tokenId: AgentTokenId.make("f1d1a000-0000-4000-8000-000000001215"),
    tag: Context.Service<ApiClient>(
      "fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceA05ApiClient"
    ),
  },
  "WA-A06": {
    bearer: AgentBearerToken.make("fin_obsa0601_0123456789abcdefghijklmnopqrstuvwxyzABCD"),
    tokenId: AgentTokenId.make("f1d1a000-0000-4000-8000-000000001216"),
    tag: Context.Service<ApiClient>(
      "fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceA06ApiClient"
    ),
  },
} as const;

/** Scenarios whose established caller can be inspected through canonical read operations. */
export type WhatsAppAcceptanceObserverId = keyof typeof acceptanceProbeCredentials;

const AcceptanceProbeApiClients = Layer.mergeAll(
  makeApiClientLive(acceptanceProbeCredentials["WA-A04"]),
  makeApiClientLive(acceptanceProbeCredentials["WA-A05"]),
  makeApiClientLive(acceptanceProbeCredentials["WA-A06"])
);

/** Read-only observations for one caller established through the public consent flow. */
export type WhatsAppAcceptanceCallerProbe = Readonly<{
  readonly userId: UserId;
  readonly api: ApiClient;
  readonly consentRecords: Effect.Effect<ReadonlyArray<ConsentRecord>>;
}>;

/**
 * Authorizes canonical observations for an established caller by inserting a scenario-specific,
 * read-only AgentToken. An unknown caller returns no probe; preparation cannot create or mutate
 * User, identity, consent, or finance state.
 */
export class WhatsAppAcceptanceCallerControl extends Context.Service<
  WhatsAppAcceptanceCallerControl,
  {
    readonly authorizeProbe: (
      observerId: WhatsAppAcceptanceObserverId,
      caller: WhatsAppCallerReference
    ) => Effect.Effect<Option.Option<WhatsAppAcceptanceCallerProbe>>;
  }
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceCallerControl") {}

/** One non-streaming language-model round retained for acceptance assertions. */
export type WhatsAppAcceptanceModelCall = Readonly<{
  readonly serializedPrompt: string;
}>;

/** Observes model rounds accumulated since the last reset; reset clears the call history. */
export class WhatsAppAcceptanceModelControl extends Context.Service<
  WhatsAppAcceptanceModelControl,
  {
    readonly calls: Effect.Effect<ReadonlyArray<WhatsAppAcceptanceModelCall>>;
    readonly reset: Effect.Effect<void>;
  }
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceModelControl") {}

const acceptanceModelReply = (serializedPrompt: string): Array<AiResponse.PartEncoded> => {
  if (serializedPrompt.includes("ACCEPTANCE_PLAIN_REPLY")) {
    return [{ type: "text" as const, text: "Todo listo." }, makeLanguageModelFinishPart("stop")];
  }
  return serializedPrompt.includes("ACCEPTANCE_TRANSIENT_CONTEXT")
    ? [
        {
          type: "tool-call" as const,
          id: "acceptance-create-transaction",
          name: "transactions__createTransaction",
          params: {
            payload: {
              money: { amount: "25000", currency: "COP" },
              counterparty: "Acceptance authority",
              direction: "outflow",
              categoryId: categoryIds.restaurantes,
              occurredAt: "2026-07-20T12:30:00Z",
            },
          },
        },
        makeLanguageModelFinishPart("tool-calls"),
      ]
    : [
        { type: "text" as const, text: "ACCEPTANCE_TRANSIENT_CONTEXT before" },
        {
          type: "tool-call" as const,
          id: "acceptance-list-categories",
          name: "categories__listCategories",
          params: {},
        },
        { type: "text" as const, text: "ACCEPTANCE_TRANSIENT_CONTEXT after" },
        makeLanguageModelFinishPart("tool-calls"),
      ];
};

const recordModelCall = (
  observedCalls: MutableRef.MutableRef<ReadonlyArray<WhatsAppAcceptanceModelCall>>,
  serializedPrompt: string
): Effect.Effect<void> =>
  Effect.sync(() => MutableRef.update(observedCalls, (calls) => [...calls, { serializedPrompt }]));

const DeterministicLanguageModel = Layer.effectContext(
  Effect.gen(function* () {
    const observedCalls = MutableRef.make<ReadonlyArray<WhatsAppAcceptanceModelCall>>([]);
    const model = yield* LanguageModel.make({
      generateText: ({ prompt }) =>
        Schema.encodeEffect(Schema.UnknownFromJsonString)(prompt).pipe(
          Effect.orDie,
          Effect.tap((serializedPrompt) => recordModelCall(observedCalls, serializedPrompt)),
          Effect.map(acceptanceModelReply)
        ),
      streamText: () =>
        Stream.die(new Error("The WhatsApp acceptance model uses non-streaming generation")),
    });
    const control = WhatsAppAcceptanceModelControl.of({
      calls: Effect.sync(() => MutableRef.get(observedCalls)),
      reset: Effect.sync(() => MutableRef.set(observedCalls, [])),
    });
    return Context.empty().pipe(
      Context.add(LanguageModel.LanguageModel, model),
      Context.add(WhatsAppAcceptanceModelControl, control)
    );
  })
);

const kapsoResourceUrl = (resource: Parameters<typeof globalThis.fetch>[0]): string => {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.href;
  return resource.url;
};

const makeAcceptanceKapsoFetch = (
  observedRequests: MutableRef.MutableRef<ReadonlyArray<WhatsAppAcceptanceKapsoRequest>>,
  configuredOutcomes: MutableRef.MutableRef<ReadonlyArray<WhatsAppAcceptanceKapsoOutcome>>,
  requestNumber: MutableRef.MutableRef<number>
): typeof globalThis.fetch =>
  Object.assign(
    (resource: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const nextRequestNumber = MutableRef.updateAndGet(requestNumber, (value) => value + 1);
      const body = Schema.decodeUnknownSync(Schema.Json)(
        Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(init?.body)
      );
      const providerMessageId = WhatsAppProviderMessageId.make(
        `wamid.acceptance-outbound-${nextRequestNumber}`
      );
      MutableRef.update(observedRequests, (requests) => [
        ...requests,
        { url: kapsoResourceUrl(resource), body, outcome: { providerMessageId } },
      ]);
      const [outcome = "accepted", ...remainingOutcomes] = MutableRef.get(configuredOutcomes);
      MutableRef.set(configuredOutcomes, remainingOutcomes);
      if (outcome === "ambiguous") return Promise.reject(new Error("synthetic transport loss"));
      if (outcome === "rejected") {
        return Promise.resolve(Response.json({ error: { code: 130429 } }, { status: 429 }));
      }
      if (outcome === "non-retryable-rejection") {
        return Promise.resolve(Response.json({ error: { code: 100 } }, { status: 400 }));
      }
      return Promise.resolve(
        Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: providerMessageId }],
        })
      );
    },
    { preconnect: () => undefined }
  );

const AcceptanceKapsoTransport = Layer.effectContext(
  Effect.gen(function* () {
    const deliveryMode = yield* Ref.make<WhatsAppAcceptanceDeliveryMode>("sandbox-phone");
    const observedRequests = MutableRef.make<ReadonlyArray<WhatsAppAcceptanceKapsoRequest>>([]);
    const configuredOutcomes = MutableRef.make<ReadonlyArray<WhatsAppAcceptanceKapsoOutcome>>([]);
    const requestNumber = MutableRef.make(0);
    const nativeFetch = makeAcceptanceKapsoFetch(
      observedRequests,
      configuredOutcomes,
      requestNumber
    );
    const client: KapsoClientService = {
      sendText: (input) =>
        Ref.get(deliveryMode).pipe(
          Effect.flatMap((mode) =>
            makeKapsoClientService({
              apiKey: "acceptance-test-api-key",
              deliveryMode: mode,
              nativeFetch,
            }).sendText(input)
          )
        ),
    };
    const control = WhatsAppAcceptanceKapsoControl.of({
      requests: Effect.sync(() => MutableRef.get(observedRequests)),
      reset: Effect.sync(() => {
        MutableRef.set(observedRequests, []);
        MutableRef.set(configuredOutcomes, []);
      }),
      setDeliveryMode: (mode) => Ref.set(deliveryMode, mode),
      setOutcomes: (outcomes) => Effect.sync(() => MutableRef.set(configuredOutcomes, outcomes)),
    });
    return Context.empty().pipe(
      Context.add(KapsoClient, client),
      Context.add(WhatsAppAcceptanceKapsoControl, control)
    );
  })
);

const runtimeHasDirectDeliveryUpdate = (runtimeSql: SqlClient.SqlClient): Effect.Effect<boolean> =>
  runtimeSql<{ readonly allowed: boolean }>`
    SELECT has_table_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'SELECT'
    ) OR has_table_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'INSERT'
    ) OR has_table_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'UPDATE'
    ) OR has_table_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'DELETE'
    ) OR has_column_privilege(
      current_user, 'pending_consent_exchanges', 'lifecycle', 'UPDATE'
    ) OR has_column_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'provider_message_id', 'UPDATE'
    ) OR has_column_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'status', 'UPDATE'
    ) OR has_column_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'safe_reason', 'UPDATE'
    ) OR has_column_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'correlation_hash', 'SELECT'
    ) OR has_table_privilege(
      current_user, 'whatsapp_consent_disclosure_delivery_attempts', 'DELETE'
    ) AS allowed
  `.pipe(
    Effect.map((rows) => rows[0]?.allowed ?? true),
    Effect.orDie
  );

const findAcceptanceDisclosure = Effect.fn("Acceptance.findDisclosure")(function* (
  migrationSql: SqlClient.SqlClient,
  runtimeSql: SqlClient.SqlClient,
  caller: WhatsAppCallerReference
) {
  const exchange = yield* findPendingConsentExchange(caller).pipe(
    Effect.provideService(SqlClient.SqlClient, runtimeSql)
  );
  if (Option.isNone(exchange)) return Option.none();
  const state = yield* SqlSchema.findOneOption({
    Request: PendingConsentExchangeId,
    Result: AcceptanceDisclosureState,
    execute: (exchangeId) => migrationSql`
      SELECT id AS "attemptId", status AS state, safe_reason AS reason,
        attempt_number AS "attemptNumber"
      FROM whatsapp_consent_disclosure_delivery_attempts
      WHERE exchange_id = ${exchangeId}
      ORDER BY attempt_number DESC LIMIT 1
    `,
  })(exchange.value.id).pipe(Effect.orDie);
  const acceptanceState = Option.map(state, (value) => ({
    ...value,
    correlationToken: DisclosureDeliveryCorrelationToken.make(value.attemptId),
  }));
  return Option.some({
    exchangeId: exchange.value.id,
    lifecycle: exchange.value._tag,
    state: acceptanceState,
  });
});

const AcceptanceDisclosureControl = Layer.effect(
  WhatsAppAcceptanceDisclosureControl,
  Effect.gen(function* () {
    const migrationSql: SqlClient.SqlClient = yield* MigrationSqlClient;
    const runtimeSql = yield* SqlClient.SqlClient;
    const kapso = yield* KapsoClient;
    const crypto = yield* Crypto.Crypto;
    return WhatsAppAcceptanceDisclosureControl.of({
      find: (caller) => findAcceptanceDisclosure(migrationSql, runtimeSql, caller),
      findAttemptByCorrelation: (token) => {
        const correlationHash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
        return SqlSchema.findOneOption({
          Request: Schema.String,
          Result: AcceptanceDisclosureAttempt,
          execute: (hash) => migrationSql`
            SELECT id AS "attemptId", exchange_id AS "exchangeId"
            FROM whatsapp_consent_disclosure_delivery_attempts
            WHERE correlation_hash = ${hash}
          `,
        })(correlationHash).pipe(Effect.orDie);
      },
      failureMetadata: (attemptId) =>
        SqlSchema.findOneOption({
          Request: DisclosureDeliveryAttemptId,
          Result: AcceptanceDisclosureFailureMetadata,
          execute: (id) => migrationSql`
            SELECT safe_reason AS reason, failure_certainty AS certainty
            FROM whatsapp_consent_disclosure_delivery_attempts
            WHERE id = ${id} AND failure_certainty IS NOT NULL
          `,
        })(attemptId).pipe(Effect.orDie),
      runtimeHasDirectDeliveryUpdate: runtimeHasDirectDeliveryUpdate(runtimeSql),
      processDue: (now) =>
        processDueConsentDisclosureDelivery(now).pipe(
          Effect.provideService(SqlClient.SqlClient, runtimeSql),
          Effect.provideService(KapsoClient, kapso),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.orDie
        ),
    });
  })
);

const AcceptanceCallerProbe = Layer.effect(
  WhatsAppAcceptanceCallerControl,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const apiClients = yield* Effect.context<ApiClient>();
    const crypto = yield* Crypto.Crypto;
    const sqlClient = yield* SqlClient.SqlClient;

    return WhatsAppAcceptanceCallerControl.of({
      authorizeProbe: (observerId, caller) =>
        Effect.gen(function* () {
          const userId = yield* findWhatsAppCaller(caller);
          if (Option.isNone(userId)) return Option.none<WhatsAppAcceptanceCallerProbe>();

          const credentials = acceptanceProbeCredentials[observerId];
          const createdAt = yield* DateTime.now;
          const tokenHash = yield* hashAgentBearer(credentials.bearer);
          yield* upsertAgentToken(userId.value, {
            id: credentials.tokenId,
            shortId: yield* getAgentTokenShortId(credentials.bearer),
            tokenHash,
            scopes: AgentTokenScopes.make(["read"]),
            idleExpiresAt: yield* renewAgentTokenIdleExpiry(createdAt),
            revokedAt: Option.none(),
            createdAt,
          });
          return Option.some({
            userId: userId.value,
            api: Context.get(apiClients, credentials.tag),
            consentRecords: observeConsentRecords(userId.value).pipe(
              Effect.provideService(SqlClient.SqlClient, sqlClient)
            ),
          });
        }).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(SqlClient.SqlClient, sqlClient)
        ),
    });
  })
);

const AcceptanceApplication = Layer.mergeAll(
  HttpLive,
  DeterministicLanguageModel,
  WhatsAppWorkerLive.pipe(
    Layer.provide(AgentService.layer.pipe(Layer.provide(DeterministicLanguageModel)))
  )
).pipe(
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive),
  Layer.provide(TelemetryDisabled)
);

/**
 * Full WhatsApp acceptance process over a real socket and real PostgreSQL. Only the external
 * Kapso transport and language model are deterministic substitutes; repositories and workers are
 * the same layers used by production.
 */
export const WhatsAppAcceptanceHarness = AcceptanceApplication.pipe(
  Layer.provideMerge(AcceptanceCallerProbe),
  Layer.provideMerge(AcceptanceDisclosureControl),
  Layer.provideMerge(AcceptanceKapsoTransport),
  Layer.provideMerge(
    makeApiClientLive({ tag: WhatsAppAcceptanceApiClient, bearer: defaultAgentBearer })
  ),
  Layer.provideMerge(AcceptanceProbeApiClients),
  Layer.provideMerge(makeDevelopmentSeedLive(defaultAgentBearer)),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(TestPublicNamespace)
);
