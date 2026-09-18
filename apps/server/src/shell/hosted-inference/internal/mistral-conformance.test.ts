import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Ref, Schema } from "effect";
import type { OutboundHttpRequest } from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
import { testOutboundTransportLayer } from "~/shell/outbound-http/testing";
import { type MistralV13Messages, countMistralV13Messages } from "./mistral-tokenizer";
import { mistralConformanceModel, verifyMistralTokenConformance } from "./mistral-conformance";
import { verifyMistralTokenConformance as verifyRuntimeConformance } from "~/shell/hosted-inference/mistral-conformance-runtime";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const MistralMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});
const MistralMessages = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
    Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  ]),
  [MistralMessage]
);

const decodeRequest = Effect.fn("Test.decodeMistralRequest")(function* (
  request: OutboundHttpRequest
) {
  if (request._tag !== "MistralChatCompletions") {
    return yield* Effect.die("Expected a Mistral conformance request");
  }
  const json = yield* Schema.decodeEffect(UnknownJsonString)(request.body);
  return yield* Schema.decodeUnknownEffect(JsonRecord)(json);
});

type AccountingResponse = Readonly<{
  model: string;
  usage: Readonly<{ prompt_tokens: number }>;
}>;

const makeAccountingOutbound = (
  requests: Ref.Ref<ReadonlyArray<OutboundHttpRequest>>,
  responseForPromptTokens: (promptTokens: number) => AccountingResponse = (promptTokens) => ({
    model: mistralConformanceModel,
    usage: { prompt_tokens: promptTokens },
  })
): OutboundHttpService => ({
  execute: (request) =>
    Effect.gen(function* () {
      yield* Ref.update(requests, (all) => [...all, request]);
      const body = yield* decodeRequest(request).pipe(Effect.orDie);
      const messages: MistralV13Messages = yield* Schema.decodeUnknownEffect(MistralMessages)(
        body.messages
      ).pipe(Effect.orDie);
      const promptTokens = countMistralV13Messages(messages);
      const responseBody = yield* Schema.encodeEffect(UnknownJsonString)(
        responseForPromptTokens(promptTokens)
      ).pipe(Effect.orDie);
      return { status: 200, headers: {}, body: new TextEncoder().encode(responseBody) };
    }),
});

it.effect("sends schema differentials and the production Compaction reserve", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<OutboundHttpRequest>>([]);
    const reports = yield* verifyMistralTokenConformance.pipe(
      Effect.provideService(OutboundHttp, makeAccountingOutbound(requests))
    );
    const sent = yield* Ref.get(requests);
    const bodies = yield* Effect.forEach(sent, decodeRequest);

    expect(sent.every((request) => request._tag === "MistralChatCompletions")).toBe(true);
    expect(reports.map((report) => report.id)).toEqual([
      "baseline",
      "small-schema",
      "large-schema",
      "production-compaction",
    ]);
    expect(bodies[0]?.response_format).toBeUndefined();
    expect(bodies[1]?.response_format).toBeDefined();
    expect(bodies[2]?.response_format).toBeDefined();
    expect(bodies[3]).toMatchObject({
      model: mistralConformanceModel,
      max_tokens: 16_000,
      temperature: 0,
    });
    expect(reports[3]?.completeRequestTokens).toBe((reports[3]?.localPromptTokens ?? 0) + 16_000);
  })
);

it.effect("rejects provider identity and prompt accounting disagreement", () =>
  Effect.gen(function* () {
    const probes = [
      {
        reason: "provider_model_mismatch",
        response: (promptTokens: number): AccountingResponse => ({
          model: "different-model",
          usage: { prompt_tokens: promptTokens },
        }),
      },
      {
        reason: "prompt_count_mismatch",
        response: (promptTokens: number): AccountingResponse => ({
          model: mistralConformanceModel,
          usage: { prompt_tokens: promptTokens + 1 },
        }),
      },
    ] as const;

    for (const probe of probes) {
      const requests = yield* Ref.make<ReadonlyArray<OutboundHttpRequest>>([]);
      const failure = yield* verifyMistralTokenConformance.pipe(
        Effect.provideService(OutboundHttp, makeAccountingOutbound(requests, probe.response)),
        Effect.flip
      );
      expect(failure.reason).toBe(probe.reason);
    }
  })
);

it.effect("fails without exposing the credential or provider body", () =>
  Effect.gen(function* () {
    const secret = "credential-private-sentinel";
    const privateBody = "response-private-sentinel";
    let observedAuthorization = "";
    const context = yield* Layer.build(
      OutboundHttp.mistralLayer.pipe(
        Layer.provide(
          testOutboundTransportLayer((request) => {
            observedAuthorization = new Headers(request.headers).get("authorization") ?? "";
            return Effect.succeed(new Response(privateBody, { status: 500 }));
          })
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ MISTRAL_API_KEY: secret })))
      )
    );
    const outbound = Context.get(context, OutboundHttp);
    const exit = yield* verifyMistralTokenConformance.pipe(
      Effect.provideService(OutboundHttp, outbound),
      Effect.exit
    );

    expect(observedAuthorization).toBe(`Bearer ${secret}`);
    expect(exit).toMatchObject({ _tag: "Failure" });
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause);
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(privateBody);
      expect(rendered).not.toContain("api.mistral.ai");
    }
  })
);

it.effect("projects safe numeric evidence from the internal probe", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<OutboundHttpRequest>>([]);
    const reports = yield* verifyRuntimeConformance.pipe(
      Effect.provideService(OutboundHttp, makeAccountingOutbound(requests))
    );

    expect(reports.map((report) => report.id)).toEqual([
      "baseline",
      "small-schema",
      "large-schema",
      "production-compaction",
    ]);
    expect(
      reports.every(
        (report) => report.completeRequestTokens === report.localPromptTokens + report.outputReserve
      )
    ).toBe(true);
  })
);

it.effect("maps internal conformance failures to safe workflow errors", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<OutboundHttpRequest>>([]);
    const failure = yield* verifyRuntimeConformance.pipe(
      Effect.provideService(
        OutboundHttp,
        makeAccountingOutbound(requests, (promptTokens) => ({
          model: "different-model",
          usage: { prompt_tokens: promptTokens },
        }))
      ),
      Effect.flip
    );

    expect(failure).toMatchObject({
      _tag: "MistralConformanceError",
      reason: "provider_model_mismatch",
      caseId: "baseline",
    });
  })
);
