import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { RecoveryInput } from "./contract";
import { makeRecoveryClient } from "./runtime";

const input = Schema.decodeSync(RecoveryInput)({
  pairingCode: "BCDF-GHJK",
  backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
});

it.effect("approves only through the fixed Access route without exporting either proof", () =>
  Effect.gen(function* () {
    const submit = makeRecoveryClient(
      HttpClient.make((request) => {
        expect(request.url).toBe("https://api.fidyapp.com/internal/support-recovery");
        expect(request.method).toBe("POST");
        expect(request.headers["cf-access-token"]).toBe("access-token");
        expect(request.headers["authorization"]).toBeUndefined();
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ status: "approved" }))
        );
      })
    );
    expect(yield* submit(input, Redacted.make("access-token"))).toBe("approved");
  })
);

it.effect("a lost or contradictory response never approves or retries recovery", () =>
  Effect.gen(function* () {
    const cases = [
      new Response("{broken", { status: 200 }),
      Response.json({ status: "approved" }, { status: 400 }),
      new Response("redirect", { status: 302, headers: { location: "https://attacker.invalid" } }),
      new Response("x".repeat(2048)),
    ];
    for (const response of cases) {
      let requests = 0;
      const submit = makeRecoveryClient(
        HttpClient.make((request) => {
          requests += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        })
      );
      expect(yield* submit(input, Redacted.make("access"))).toBe("uncertain");
      expect(requests).toBe(1);
    }
  })
);

it.effect("authoritative refusals reveal no claimant match details", () =>
  Effect.gen(function* () {
    for (const response of [
      Response.json({ status: "not_approved" }, { status: 400 }),
      Response.json({ status: "unauthorized" }, { status: 401 }),
      Response.json({ status: "limited" }, { status: 429 }),
      Response.json({ status: "unavailable" }, { status: 503 }),
    ]) {
      const submit = makeRecoveryClient(
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)))
      );
      const outcome = yield* submit(input, Redacted.make("access"));
      expect(outcome).toBe(response.status === 400 ? "not_approved" : "unavailable");
    }
  })
);

it.effect("a response deadline releases owned transport and preserves uncertainty", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let released = false;
    const submit = makeRecoveryClient(
      HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            })
          )
        )
      )
    );
    const fiber = yield* submit(input, Redacted.make("access")).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("16 seconds");
    expect(yield* Fiber.join(fiber)).toBe("uncertain");
    expect(released).toBe(true);
  })
);

it.effect("interruption releases a held response reader without a second decision", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let cancelled = false;
    const submit = makeRecoveryClient(
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                pull: (): void => {
                  Deferred.doneUnsafe(started, Effect.void);
                },
                cancel: (): void => {
                  cancelled = true;
                },
              })
            )
          )
        )
      )
    );
    const fiber = yield* submit(input, Redacted.make("access")).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(cancelled).toBe(true);
  })
);
