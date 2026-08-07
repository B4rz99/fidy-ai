import { expect, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { makeOpenAiTextResponse } from "~/shell/agent/fixtures/openai";
import { AgentToolkit } from "./toolkit";
import { HostedAgentGenerationConfig, HostedAgentModel, OpenAiLanguageModelLive } from "./openai";

const configLayer = (entries: ReadonlyArray<readonly [string, string]>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(Object.fromEntries(entries)));

const NoNetworkHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Production OpenAI assembly must not make a request"))
);

it.effect("constructs the fixed hosted model from a configured secret", () =>
  Effect.gen(function* () {
    const configured = OpenAiLanguageModelLive.pipe(
      Layer.provide(NoNetworkHttpClient),
      Layer.provide(configLayer([["OPENAI_API_KEY", "test-only-secret"]]))
    );

    yield* Effect.scoped(Layer.build(configured));
    expect(HostedAgentModel).toBe("gpt-5.6-luna");
    expect(HostedAgentGenerationConfig).toEqual({
      temperature: 0.7,
      reasoning: { effort: "none" },
    });
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

const OpenAiRequest = Schema.Struct({
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        parameters: Schema.optionalKey(Schema.Unknown),
      })
    )
  ),
});

it.effect("sends the assembled toolkit's empty inputs as closed objects", () =>
  Effect.gen(function* () {
    const capturedRequest = yield* Ref.make<Option.Option<HttpClientRequest.HttpClientRequest>>(
      Option.none()
    );
    const responseBody = makeOpenAiTextResponse("");
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.set(capturedRequest, Option.some(request));
        return HttpClientResponse.fromWeb(
          request,
          new Response(responseBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      })
    );
    const model = OpenAiLanguageModelLive.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provide(configLayer([["OPENAI_API_KEY", "test-only-secret"]]))
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(model);
        const languageModel = Context.get(context, LanguageModel.LanguageModel);
        yield* LanguageModel.generateText({
          prompt: "Use the canonical toolkit.",
          toolkit: AgentToolkit,
          disableToolCallResolution: true,
        }).pipe(Effect.provideService(LanguageModel.LanguageModel, languageModel));
      })
    );

    const request = Option.getOrThrow(yield* Ref.get(capturedRequest));
    if (request.body._tag !== "Uint8Array") {
      return yield* Effect.die("Expected an encoded OpenAI request body");
    }
    const body = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      new TextDecoder().decode(request.body.body)
    );
    const categoriesTool = yield* Schema.decodeUnknownEffect(OpenAiRequest)(body).pipe(
      Effect.map((decoded) =>
        decoded.tools?.find(({ name }) => name === "categories__listCategories")
      )
    );
    expect(categoriesTool?.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  })
);
