import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";
import { OpenAiLanguageModelLive, HostedAgentModel } from "./openai";

const configLayer = (entries: ReadonlyArray<readonly [string, string]>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(Object.fromEntries(entries)));

const NoNetworkHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Production OpenAI assembly must not make a request"))
);

it.effect("constructs the fixed gpt-5.4-nano model from a configured secret", () =>
  Effect.gen(function* () {
    const configured = OpenAiLanguageModelLive.pipe(
      Layer.provide(NoNetworkHttpClient),
      Layer.provide(configLayer([["OPENAI_API_KEY", "test-only-secret"]]))
    );

    yield* Effect.scoped(Layer.build(configured));
    expect(HostedAgentModel).toBe("gpt-5.4-nano");
  })
);

it.effect("fails closed when the OpenAI secret is absent", () =>
  Effect.gen(function* () {
    const unconfigured = OpenAiLanguageModelLive.pipe(
      Layer.provide(NoNetworkHttpClient),
      Layer.provide(configLayer([]))
    );

    const exit = yield* Effect.exit(Effect.scoped(Layer.build(unconfigured)));
    expect(Exit.isFailure(exit)).toBe(true);
  })
);
