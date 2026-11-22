import { Array as Arr, Context, Effect, Layer, Predicate, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import {
  makeAccessSigningKeysOutboundHttp,
  makeGoogleOutboundHttp,
  makeMicrosoftOutboundHttp,
} from "../../src/shell/outbound-http/operations";
import {
  OutboundHttpRequest,
  ProviderOidcHttpRequest,
} from "../../src/shell/outbound-http/contract";

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
            url: new Request(input).url,
            init: {
              method: init?.method,
              headers: init?.headers,
              redirect: init?.redirect,
              body: Predicate.isUint8Array(init?.body)
                ? new TextDecoder().decode(init.body)
                : undefined,
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

const checkProviderOidc = Effect.fn(function* (
  runtime: Miniflare,
  makeHttp: typeof makeGoogleOutboundHttp,
  status: number
) {
  const observed = { calls: 0 };

  const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
    Effect.provideService(FetchHttpClient.Fetch, makeProviderFetch(runtime, status, observed))
  );

  const http = makeHttp({
    clientId: "synthetic-client",
    clientSecret: Redacted.make("synthetic-secret"),
    redirectUri: "https://api.fidyapp.com/providers/test/callback",
    httpClient: Context.get(clients, HttpClient.HttpClient),
  });

  yield* Effect.forEach(
    [
      ProviderOidcHttpRequest.SigningKeys(),
      ProviderOidcHttpRequest.TokenExchange({
        code: Redacted.make("synthetic-code"),
        verifier: Redacted.make("synthetic-verifier"),
      }),
    ],
    Effect.fnUntraced(function* (request) {
      expect((yield* http.execute(request)).status).toBe(status);
    }),
    { discard: true }
  );

  return observed.calls;
}, Effect.scoped);

it("Access recovery signing-key requests work in Workers without following redirects", () =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(createRuntime),
      (runtime) =>
        Effect.scoped(
          Effect.forEach(
            [200, 302],
            Effect.fnUntraced(function* (status) {
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

              expect(
                (yield* http.execute(OutboundHttpRequest.CloudflareAccessSigningKeys())).status
              ).toBe(status);
              expect(observed.calls).toBe(1);
            }),
            { discard: true }
          )
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
            const calls = yield* Effect.forEach(
              Arr.cartesian([makeGoogleOutboundHttp, makeMicrosoftOutboundHttp], [200, 302]),
              ([makeHttp, status]) => checkProviderOidc(runtime, makeHttp, status)
            );

            expect(calls).toEqual([2, 2, 2, 2]);
          })
        ),
      (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
    )
  ));
