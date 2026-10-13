import { expect, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";
import { outboundFetchHttpClientLayer } from "./runtime";
import { WhatsAppBusinessPhoneNumberId, WhatsAppMediaId } from "~/shell/channels/whatsapp/contract";

const pendingCancellation = (): Promise<void> => Promise.withResolvers<void>().promise;
const makeTransport = Effect.fn(function* (response: Response) {
  const fetch: typeof globalThis.fetch = Object.assign(
    (): Promise<Response> => Promise.resolve(response),
    { preconnect: (): void => undefined }
  );
  const services = yield* Layer.build(
    outboundFetchHttpClientLayer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  );
  return makeKapsoOutboundHttp({
    apiKey: Redacted.make("test-secret"),
    httpClient: Context.get(services, HttpClient.HttpClient),
  });
});
const request = {
  _tag: "KapsoMediaMetadata",
  mediaId: Schema.decodeSync(WhatsAppMediaId)("test"),
  businessPhoneNumberId: Schema.decodeSync(WhatsAppBusinessPhoneNumberId)("123"),
} as const;

for (const declared of [false, true]) {
  it.effect(
    `releases native overflow ownership with pending cancellation (declared=${declared})`,
    () =>
      Effect.gen(function* () {
        let cancelled = false;
        const raw = new ReadableStream<Uint8Array>({
          pull: (controller): void => controller.enqueue(new Uint8Array(65_537)),
          cancel: (): Promise<void> => {
            cancelled = true;
            return pendingCancellation();
          },
        });
        const outbound = yield* makeTransport(
          new Response(raw, {
            headers: declared ? { "content-length": "65537" } : {},
          })
        );
        const result = yield* outbound.execute(request).pipe(Effect.exit);
        expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true);
        expect(cancelled).toBe(true);
        expect(raw.locked).toBe(false);
      })
  );
}

for (const termination of ["timeout", "interruption"] as const) {
  it.effect(`releases stalled native response after ${termination} with pending cancellation`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const services = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(services);
      let cancelled = false;
      const raw = new ReadableStream<Uint8Array>(
        {
          pull: (): Promise<void> => {
            runPromise(Deferred.succeed(started, undefined)).catch(() => undefined);
            return pendingCancellation();
          },
          cancel: (): Promise<void> => {
            cancelled = true;
            return pendingCancellation();
          },
        },
        { highWaterMark: 0 }
      );
      const outbound = yield* makeTransport(new Response(raw));
      const execution = outbound.execute(request);
      const fiber = yield* (
        termination === "timeout" ? execution.pipe(Effect.timeout("1 second")) : execution
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (termination === "timeout") yield* TestClock.adjust("1 second");
      else yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cancelled).toBe(true);
      expect(raw.locked).toBe(false);
    })
  );
}

it.effect("releases successful native body ownership", () =>
  Effect.gen(function* () {
    const raw = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const outbound = yield* makeTransport(new Response(raw));
    const response = yield* outbound.execute(request);
    expect(response.body).toEqual(new Uint8Array([1, 2]));
    expect(raw.locked).toBe(false);
  })
);

it.effect("rejects malformed native response chunks and releases ownership", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const raw = new ReadableStream<unknown>({
      pull: (controller): void => controller.enqueue("invalid native bytes"),
      cancel: (): Promise<void> => {
        cancelled = true;
        return pendingCancellation();
      },
    });
    const outbound = yield* makeTransport(new Response(raw));
    const result = yield* outbound.execute(request).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(cancelled).toBe(true);
    expect(raw.locked).toBe(false);
  })
);
