import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { protectClient } from "./runtime";

it.effect("cancels a dishonest oversized response before decoding it", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const tooManyBytes = 20_000;
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(new Uint8Array(tooManyBytes));
      },
      cancel: (): void => {
        cancelled = true;
      },
    });
    const raw = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-length": "1" } })
        )
      )
    );
    const result = yield* Effect.exit(
      protectClient(raw).get("https://api.fidyapp.com/pat-pairings")
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(cancelled).toBe(true);
  })
);

it.effect("Ctrl-C style interruption aborts the request and cancels its pending reader", () =>
  Effect.gen(function* () {
    let cancelled = false;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: (): void => {
        cancelled = true;
      },
    });
    const raw = HttpClient.make((request, _url, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
    });
    const fiber = yield* protectClient(raw)
      .get("https://api.fidyapp.com/pat-pairings")
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(fiber);
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
  })
);

it.effect(
  "refuses redirected destinations and oversized requests without sending their body elsewhere",
  () =>
    Effect.gen(function* () {
      let sent = false;
      const raw = HttpClient.make((request) =>
        Effect.sync(() => {
          sent = true;
          return HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 302, headers: { location: "https://attacker.example" } })
          );
        })
      );
      const result = yield* Effect.exit(
        protectClient(raw).get("https://api.fidyapp.com/pat-pairings")
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(sent).toBe(true);
      sent = false;
      const requestCharacters = 20_000;
      const oversized = yield* Effect.exit(
        protectClient(raw).post("https://api.fidyapp.com/pat-pairings", {
          body: HttpBody.text("x".repeat(requestCharacters)),
        })
      );
      expect(Exit.isFailure(oversized)).toBe(true);
      expect(sent).toBe(false);
    })
);
