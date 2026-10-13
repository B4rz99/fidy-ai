import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { requestLocalConfirmationBridge } from "./native-confirmation-hosts";

const Finished = Schema.Struct({ finished: Schema.Literal(true) });

for (const mode of ["streamed-overflow", "declared-overflow", "redirect", "malformed"] as const) {
  it.effect(`refuses ${mode} bridge data without exposing its contents`, () =>
    Effect.gen(function* () {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          if (mode === "streamed-overflow") controller.enqueue(new Uint8Array(65_537));
          if (mode === "malformed") {
            controller.enqueue(new TextEncoder().encode("private bridge diagnostic"));
            controller.close();
          }
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.url).toBe("http://127.0.0.1:19488/finish");
          expect((yield* FetchHttpClient.RequestInit).redirect).toBe("manual");
          expect((yield* HttpClient.TracerDisabledWhen)(request)).toBe(true);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: mode === "redirect" ? 302 : 200,
              headers: mode === "declared-overflow" ? { "content-length": "65537" } : {},
            })
          );
        })
      );
      const result = yield* requestLocalConfirmationBridge({
        path: "/finish",
        codec: Finished,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(String(result)).not.toContain("private bridge diagnostic");
      if (mode === "streamed-overflow") expect(cancelled).toBe(true);
    })
  );
}

for (const mode of ["deadline", "interruption"] as const) {
  it.effect(`bounds a stalled bridge body during ${mode}`, () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(): void {
            Deferred.doneUnsafe(started, Effect.void);
          },
          cancel(): void {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
      );
      const request = yield* Effect.forkChild(
        requestLocalConfirmationBridge({ path: "/finish", codec: Finished }).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )
      );
      yield* Deferred.await(started);
      if (mode === "deadline") yield* TestClock.adjust("10 seconds");
      else yield* Fiber.interrupt(request);
      const result = yield* Fiber.await(request);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.hasInterrupts(result.cause)).toBe(mode === "interruption");
      }
      expect(cancelled).toBe(true);
    })
  );
}
