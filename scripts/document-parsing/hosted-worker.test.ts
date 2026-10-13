import { expect, layer } from "@effect/vitest";
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { deleteProofWorker } from "./hosted-worker";
import { ProofHttpLive } from "./local-workerd-http";

const name = "xlsx-proof-0123abcd";
const token = "synthetic-cloudflare-proof-secret";
const privateDetail = "private-provider-diagnostic";
const maximumResponseBytes = 65_536;

const nativeFetch = (
  handle: (request: Request, init?: RequestInit) => Promise<Response>
): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      handle(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        init
      ),
    { preconnect: (): void => undefined }
  );

const expectClosedRefusal = <A, E>(result: Exit.Exit<A, E>): void => {
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isSuccess(result)) return;
  expect(Cause.hasFails(result.cause)).toBe(true);
  const diagnostics = String(result);
  expect(diagnostics).toContain("HostedProofCommandFailed");
  expect(diagnostics).not.toContain(privateDetail);
  expect(diagnostics).not.toContain(token);
};

let currentFetch: typeof fetch = nativeFetch(() =>
  Promise.reject(new Error("The isolated proof provider was not configured"))
);
const providerLayer = ProofHttpLive.pipe(
  Layer.provide(
    Layer.succeed(
      FetchHttpClient.Fetch,
      nativeFetch((request, init) => currentFetch(request, init))
    )
  )
);

layer(providerLayer, { concurrent: false })("hosted proof Worker deletion security", (it) => {
  const deletion = (
    worker: string,
    native: typeof fetch
  ): Effect.Effect<
    void,
    Effect.Error<ReturnType<typeof deleteProofWorker>>,
    HttpClient.HttpClient
  > =>
    Effect.sync(() => {
      currentFetch = native;
    }).pipe(
      Effect.andThen(() => deleteProofWorker(worker)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          CLOUDFLARE_ACCOUNT_ID: "isolated-account",
          CLOUDFLARE_API_TOKEN: token,
        })
      )
    );

  for (const invalid of [
    "production",
    "../../production",
    "xlsx-proof-0123abcd/foreign",
    "xlsx-proof-ABCDEF01",
  ]) {
    it.effect(`refuses invalid proof Worker identity ${invalid} before provider I/O`, () =>
      Effect.gen(function* () {
        let calls = 0;
        const result = yield* deletion(
          invalid,
          nativeFetch(() => {
            calls += 1;
            return Promise.resolve(new Response(null, { status: 204 }));
          })
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(calls).toBe(0);
        expect(String(result)).not.toContain(token);
      })
    );
  }

  it.effect("refuses provider redirects without forwarding the deletion credential", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const result = yield* deletion(
        name,
        nativeFetch((request, init) => {
          requests.push(request);
          if (init?.redirect !== "manual") {
            requests.push(
              new Request("https://foreign.example/workers", { headers: request.headers })
            );
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(
            Response.json(
              { errors: [{ code: 3030, message: privateDetail }] },
              {
                status: 302,
                headers: { location: "https://foreign.example/workers" },
              }
            )
          );
        })
      ).pipe(Effect.exit);
      expectClosedRefusal(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/isolated-account/workers/scripts/${name}`
      );
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    })
  );

  for (const declared of [false, true]) {
    it.effect(
      `refuses ${declared ? "declared" : "streamed"} oversized provider bytes without waiting for cancellation`,
      () =>
        Effect.gen(function* () {
          let cancelled = false;
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              pull: (controller): void => {
                pulls += 1;
                controller.enqueue(new Uint8Array(maximumResponseBytes + 1));
              },
              cancel: (): Promise<void> => {
                cancelled = true;
                return Promise.withResolvers<void>().promise;
              },
            },
            { highWaterMark: 0 }
          );
          const result = yield* deletion(
            name,
            nativeFetch(() =>
              Promise.resolve(
                new Response(body, {
                  status: 403,
                  headers: declared ? { "content-length": String(maximumResponseBytes + 1) } : {},
                })
              )
            )
          ).pipe(Effect.exit);
          expectClosedRefusal(result);
          expect(cancelled).toBe(true);
          expect(body.locked).toBe(false);
          expect(pulls).toBe(declared ? 0 : 1);
        })
    );
  }

  for (const body of [
    privateDetail,
    `{"errors":[{"code":"${privateDetail}","message":"${token}"}]}`,
  ]) {
    it.effect("maps malformed provider JSON to closed deletion diagnostics", () =>
      Effect.gen(function* () {
        const result = yield* deletion(
          name,
          nativeFetch(() => Promise.resolve(new Response(body, { status: 403 })))
        ).pipe(Effect.exit);
        expectClosedRefusal(result);
      })
    );
  }

  for (const termination of ["timeout", "interruption"] as const) {
    it.effect(
      `releases stalled provider ownership after ${termination} without awaiting native cancellation`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>(
            {
              pull: (): Promise<void> => {
                runPromise(Deferred.succeed(started, undefined)).catch(() => undefined);
                return Promise.withResolvers<void>().promise;
              },
              cancel: (): Promise<void> => {
                cancelled = true;
                return Promise.withResolvers<void>().promise;
              },
            },
            { highWaterMark: 0 }
          );
          const fiber = yield* deletion(
            name,
            nativeFetch(() => Promise.resolve(new Response(body, { status: 403 })))
          ).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          if (termination === "timeout") yield* TestClock.adjust("10 seconds");
          else yield* Fiber.interrupt(fiber);
          const result = yield* Fiber.await(fiber);
          if (termination === "timeout") expectClosedRefusal(result);
          else expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
          expect(cancelled).toBe(true);
          expect(body.locked).toBe(false);
        })
    );
  }
});
