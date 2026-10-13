import { Context, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import {
  makeAccessSigningKeysOutboundHttp,
  makeGoogleOutboundHttp,
  makeMicrosoftOutboundHttp,
} from "../../src/shell/outbound-http/operations";

// Substitute the provider response after workerd validates the actual fetch options.
// Node/Bun fetch mocks accept redirect modes that Workers rejects before network I/O.
const providerWorker = `export default { async fetch(request) {
  const input = await request.json();
  try {
    new Request(input.url, input.init);
    return new Response('{}', { status: input.status });
  } catch {
    return new Response('Workers rejected request options', { status: 500 });
  }
}}`;

const createRuntime = (): Miniflare =>
  new Miniflare({
    workers: [
      {
        config: {
          name: "oidc-transport",
          type: "worker",
          compatibilityDate: "2026-09-08",
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { contents: providerWorker, type: "esm" } },
          },
        },
      },
    ],
  });

const makeProviderFetch = (
  runtime: Miniflare,
  status: number,
  observed: { calls: number }
): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      observed.calls += 1;
      return runtime
        .dispatchFetch("http://provider", {
          method: "POST",
          body: JSON.stringify({
            url: input instanceof Request ? input.url : input.toString(),
            init: {
              method: init?.method,
              headers: init?.headers,
              redirect: init?.redirect,
              body:
                init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : undefined,
            },
            status,
          }),
        })
        .then((response) =>
          response.arrayBuffer().then(
            (body) =>
              new Response(body, {
                status: response.status,
                headers: Object.fromEntries(response.headers),
              })
          )
        );
    },
    { preconnect: (): void => undefined }
  );

it("Access recovery signing-key requests work in Workers without following redirects", () =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(createRuntime),
      (runtime) =>
        Effect.scoped(
          Effect.gen(function* () {
            for (const status of [200, 302]) {
              const observed = { calls: 0 };
              const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
                Effect.provideService(
                  FetchHttpClient.Fetch,
                  makeProviderFetch(runtime, status, observed)
                )
              );
              const http = makeAccessSigningKeysOutboundHttp({
                issuer: "https://synthetic.cloudflareaccess.com",
                httpClient: Context.get(clients, HttpClient.HttpClient),
              });
              expect((yield* http.execute({ _tag: "CloudflareAccessSigningKeys" })).status).toBe(
                status
              );
              expect(observed.calls).toBe(1);
            }
          })
        ),
      (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
    )
  ));

it("Google and Microsoft OIDC requests work in Workers and return redirects without following them", () =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(createRuntime),
      (runtime) =>
        Effect.scoped(
          Effect.gen(function* () {
            for (const makeHttp of [makeGoogleOutboundHttp, makeMicrosoftOutboundHttp]) {
              for (const status of [200, 302]) {
                const observed = { calls: 0 };
                const providerFetch = makeProviderFetch(runtime, status, observed);
                const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
                  Effect.provideService(FetchHttpClient.Fetch, providerFetch)
                );
                const http = makeHttp({
                  clientId: "synthetic-client",
                  clientSecret: Redacted.make("synthetic-secret"),
                  redirectUri: "https://api.fidyapp.com/providers/test/callback",
                  httpClient: Context.get(clients, HttpClient.HttpClient),
                });
                for (const request of [
                  { _tag: "SigningKeys" },
                  {
                    _tag: "TokenExchange",
                    code: Redacted.make("synthetic-code"),
                    verifier: Redacted.make("synthetic-verifier"),
                  },
                ] as const) {
                  expect((yield* http.execute(request)).status).toBe(status);
                }
                expect(observed.calls).toBe(2);
              }
            }
          })
        ),
      (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
    )
  ));
