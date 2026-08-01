import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { AgentServiceLive } from "~/shell/agent/agent-service";
import { OpenAiLanguageModelLive } from "~/shell/agent/openai";
import { runAgentRepl } from "~/shell/agent/repl";
import { CanonicalApiBaseUrl, CanonicalApiUrl } from "~/shell/agent/toolkit";
import { MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/db/client";

const program = Effect.gen(function* () {
  const userId = yield* Config.string("FIDY_REPL_USER_ID").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UserId))
  );
  const baseUrl = yield* Config.string("FIDY_API_BASE_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000"),
    Effect.flatMap(Schema.decodeUnknownEffect(CanonicalApiUrl))
  );
  yield* runAgentRepl(userId).pipe(
    Effect.provideService(CanonicalApiBaseUrl, Option.some(baseUrl))
  );
});

const AgentLive = AgentServiceLive.pipe(Layer.provide(OpenAiLanguageModelLive));
const InfrastructureLive = Layer.mergeAll(PgLive, BunHttpClient.layer, BunServices.layer);
const ReplLive = AgentLive.pipe(
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive),
  Layer.provideMerge(InfrastructureLive)
);
const MainLive = Layer.effectDiscard(program).pipe(Layer.provide(ReplLive));

BunRuntime.runMain(Layer.launch(MainLive));
