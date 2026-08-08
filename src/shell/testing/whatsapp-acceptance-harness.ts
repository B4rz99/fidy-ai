import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, MutableRef, Ref, Schema, Stream } from "effect";
import { type Response as AiResponse, LanguageModel } from "effect/unstable/ai";
import { categoryIds } from "~/core/categories/taxonomy";
import { AgentService } from "~/shell/agent/agent-service";
import {
  KapsoClient,
  type KapsoClientService,
  makeKapsoClientService,
} from "~/shell/channels/whatsapp/kapso-client";
import { WhatsAppWorkerLive } from "~/shell/channels/whatsapp/worker";
import { MigrationSqlClient, MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { HttpLive } from "~/shell/http";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { type ApiClient, makeApiClientLive } from "./api-harness";
import { defaultAgentBearer } from "./identity-fixtures";
import { makeLanguageModelFinishPart } from "./language-model-fixtures";
import { TestPublicNamespace } from "./test-config";

export type WhatsAppAcceptanceDeliveryMode = "bsuid" | "sandbox-phone";

/** One synthetic Kapso HTTP request retained only in memory for acceptance assertions. */
export type WhatsAppAcceptanceKapsoRequest = Readonly<{
  readonly url: string;
  readonly body: Schema.Json;
}>;

/**
 * Controls the recording Kapso transport below the production serializer. `requests` returns every
 * outbound JSON body since `reset`; reset also restarts synthetic provider-message numbering.
 * `sandbox-phone` serializes a phone `to`, while `bsuid` serializes a BSUID `recipient`.
 */
export class WhatsAppAcceptanceKapsoControl extends Context.Service<
  WhatsAppAcceptanceKapsoControl,
  {
    readonly requests: Effect.Effect<ReadonlyArray<WhatsAppAcceptanceKapsoRequest>>;
    readonly reset: Effect.Effect<void>;
    readonly setDeliveryMode: (mode: WhatsAppAcceptanceDeliveryMode) => Effect.Effect<void>;
  }
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceKapsoControl") {}

/** Authenticated public canonical API client for the seeded acceptance User. */
export class WhatsAppAcceptanceApiClient extends Context.Service<
  WhatsAppAcceptanceApiClient,
  ApiClient
>()("fidy-ai/shell/testing/whatsapp-acceptance-harness/WhatsAppAcceptanceApiClient") {}

const acceptanceModelReply = (serializedPrompt: string): Array<AiResponse.PartEncoded> =>
  serializedPrompt.includes("ACCEPTANCE_TRANSIENT_CONTEXT")
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

const DeterministicLanguageModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: ({ prompt }) => Effect.succeed(acceptanceModelReply(JSON.stringify(prompt))),
    streamText: () =>
      Stream.die(new Error("The WhatsApp acceptance model uses non-streaming generation")),
  })
);

const kapsoResourceUrl = (resource: Parameters<typeof globalThis.fetch>[0]): string => {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.href;
  return resource.url;
};

const AcceptanceKapsoTransport = Layer.effectContext(
  Effect.gen(function* () {
    const deliveryMode = yield* Ref.make<WhatsAppAcceptanceDeliveryMode>("sandbox-phone");
    const observedRequests = MutableRef.make<ReadonlyArray<WhatsAppAcceptanceKapsoRequest>>([]);
    const requestNumber = MutableRef.make(0);
    const nativeFetch: typeof globalThis.fetch = Object.assign(
      (resource: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const nextRequestNumber = MutableRef.updateAndGet(requestNumber, (value) => value + 1);
        const body = Schema.decodeUnknownSync(Schema.Json)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(init?.body)
        );
        MutableRef.update(observedRequests, (requests) => [
          ...requests,
          { url: kapsoResourceUrl(resource), body },
        ]);
        return Promise.resolve(
          Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: `wamid.acceptance-outbound-${nextRequestNumber}` }],
          })
        );
      },
      { preconnect: () => undefined }
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
        MutableRef.set(requestNumber, 0);
      }),
      setDeliveryMode: (mode) => Ref.set(deliveryMode, mode),
    });
    return Context.empty().pipe(
      Context.add(KapsoClient, client),
      Context.add(WhatsAppAcceptanceKapsoControl, control)
    );
  })
);

const AcceptanceApplication = Layer.mergeAll(
  HttpLive,
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
  Layer.provideMerge(AcceptanceKapsoTransport),
  Layer.provideMerge(
    makeApiClientLive({ tag: WhatsAppAcceptanceApiClient, bearer: defaultAgentBearer })
  ),
  Layer.provideMerge(makeDevelopmentSeedLive(defaultAgentBearer)),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(TestPublicNamespace)
);
