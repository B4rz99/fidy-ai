import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vitest";
import { checkSmokeExchange, exchangeSmoke } from "./smoke-exchange";

const headers = { "x-fidy-smoke-proof": "a".repeat(64) };
const exchange = (
  response: Response,
  body: Option.Option<string>
): Effect.Effect<
  Effect.Success<ReturnType<typeof exchangeSmoke>>,
  Effect.Error<ReturnType<typeof exchangeSmoke>>
> =>
  exchangeSmoke({ query: "?readiness=1", headers, body }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)))
    )
  );
const identity = {
  workerVersionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
  gitRevision: "0123456789abcdef0123456789abcdef01234567",
  contractDigest: "a".repeat(64),
};

for (const method of ["readiness", "synthetic"] as const) {
  const body = method === "readiness" ? Option.none<string>() : Option.some("{}");
  describe(`${method} smoke exchange`, () => {
    it.effect("rejects actual streamed overflow and cancels the owned reader before decoding", () =>
      Effect.gen(function* () {
        let cancelled = false;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            pull(controller): void {
              controller.enqueue(new Uint8Array(4097));
            },
            cancel(): void {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "1" } }
        );
        const result = yield* Effect.exit(exchange(response, body));
        expect(Exit.isFailure(result)).toBe(true);
        expect(cancelled).toBe(true);
      })
    );
    it.effect(
      "rejects malformed JSON without permitting a passed verdict or exposing foreign text",
      () =>
        Effect.gen(function* () {
          const result = yield* exchange(
            new Response("private-provider-body", {
              headers: {
                "cache-control": "no-store",
                "x-fidy-smoke-worker-version": identity.workerVersionId,
                "x-fidy-smoke-failure": "private-provider-stage",
              },
            }),
            body
          );
          expect(Option.isNone(result.result)).toBe(true);
          expect(Option.isNone(result.failureStage)).toBe(true);
          const checked = yield* Effect.exit(
            checkSmokeExchange(result, { public: identity, core: identity, replayIdentity: false })
          );
          expect(Exit.isFailure(checked)).toBe(true);
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            checked
          );
          expect(encoded).not.toContain("private-provider");
        })
    );
    it.effect(
      "cancels a pending reader when the caller interrupts without manufacturing a verdict",
      () =>
        Effect.gen(function* () {
          let cancelled = false;
          let reading = false;
          const response = new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {
                reading = true;
              },
              cancel(): void {
                cancelled = true;
              },
            })
          );
          const fiber = yield* Effect.forkChild(exchange(response, body));
          yield* Effect.yieldNow;
          expect(reading).toBe(true);
          yield* Fiber.interrupt(fiber);
          const result = yield* Fiber.await(fiber);
          expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
          expect(cancelled).toBe(true);
        })
    );
    it.effect(
      "contains a body transport failure without returning identity or provider error text",
      () =>
        Effect.gen(function* () {
          const response = new Response(
            new ReadableStream<Uint8Array>({
              pull(controller): void {
                controller.error(new Error("private-provider-failure"));
              },
            })
          );
          const result = yield* Effect.exit(exchange(response, body));
          expect(Exit.isFailure(result)).toBe(true);
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
          expect(encoded).not.toContain("private-provider-failure");
        })
    );
  });
}
