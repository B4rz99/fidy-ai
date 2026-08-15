import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { AgentService } from "~/shell/agent/agent-service";
import { OpenAiHostedInferenceLive } from "~/shell/agent/openai";
import { runAgentRepl } from "~/shell/agent/repl";
import { CanonicalApiBaseUrl, CanonicalApiUrl } from "~/shell/agent/toolkit";
import { MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { TelemetryDisabled } from "~/shell/observability/disabled";

const program = Effect.gen(function* () {
  const phoneNumber = yield* Config.string("FIDY_REPL_PHONE_NUMBER").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(E164PhoneNumber))
  );
  const businessScopedUserId = yield* Config.string("FIDY_REPL_BSUID").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WhatsAppBusinessScopedUserId))
  );
  const baseUrl = yield* Config.string("FIDY_API_BASE_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000"),
    Effect.flatMap(Schema.decodeUnknownEffect(CanonicalApiUrl))
  );
  yield* runAgentRepl({ phoneNumber, businessScopedUserId }).pipe(
    Effect.provideService(CanonicalApiBaseUrl, Option.some(baseUrl))
  );
});

const AgentLive = AgentService.layer.pipe(Layer.provide(OpenAiHostedInferenceLive));
const InfrastructureLive = Layer.mergeAll(PgLive, BunHttpClient.layer, BunServices.layer);
const ReplLive = AgentLive.pipe(
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive),
  Layer.provide(TelemetryDisabled),
  Layer.provideMerge(InfrastructureLive)
);
const MainLive = Layer.effectDiscard(program).pipe(Layer.provide(ReplLive));

BunRuntime.runMain(Layer.launch(MainLive));
