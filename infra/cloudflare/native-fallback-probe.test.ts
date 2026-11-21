import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { acceptanceSend, bufferedAcceptanceSend } from "./native-storage-release";
import { ReleaseHttpLive } from "./release-http";
import { controlsDigest, observePairingStart } from "./native-fallback-probe";
import { acceptanceRequestAdmitted } from "../../apps/server/cloudflare/release-isolation/operations";
import { installedOrigins } from "@fidy/server/browser-transport";
import { webSignupDisclosure } from "../../apps/server/src/shell/consent/operations";
import { acceptanceProofHeader } from "../../apps/server/cloudflare/release-isolation/contract";
import { releaseFailureMessage } from "./production-release";

type ControlResponses = ReadonlyMap<string, (request: Request) => Response>;

const serveControl = (responses: ControlResponses, request: Request): Effect.Effect<Response> =>
  Effect.sync(() => {
    const handler = responses.get(new URL(request.url).pathname);

    if (handler === undefined) throw Error("Unexpected control path");

    return handler(request);
  });

it.effect(
  "distinguishes the canonical pairing refusal while withholding unrecognized provider bytes",
  () =>
    Effect.gen(function* () {
      const refusal =
        '{"error":{"code":"unavailable","message":"The operation is unavailable. Retry later."},"next":[]}';

      yield* Effect.forEach(
        [refusal, "private error detail", refusal + "private error detail"],
        Effect.fnUntraced(function* (body) {
          const outcome = yield* controlsDigest(
            {
              revision: "b".repeat(40),
              proof: "0".repeat(64),
              core: "11111111-1111-4111-8111-111111111111",
              ingress: "22222222-2222-4222-8222-222222222222",
            },
            (request) => {
              expect(new URL(request.url).pathname).toBe("/web/pairings");

              return Effect.succeed(new Response(body, { status: 503 }));
            }
          ).pipe(
            Effect.matchCause({ onFailure: releaseFailureMessage, onSuccess: () => "accepted" })
          );

          expect(outcome).toBe(
            "Retained control refused at pairing start, HTTP 503" +
              (body === refusal ? ", canonical admission unavailable" : "")
          );
        }),
        { discard: true }
      );
    })
);

it.live(
  "compares the ordinary protected pairing request with a separately authenticated empty POST",
  () =>
    Effect.gen(function* () {
      const pair = {
        revision: "b".repeat(40),
        proof: "0".repeat(64),
        core: "11111111-1111-4111-8111-111111111111",
        ingress: "22222222-2222-4222-8222-222222222222",
      };

      const wire = Effect.fn(function* (request: Request) {
        const { api, browser } = installedOrigins.acceptance;
        expect(request.url).toBe(api + "/web/pairings");
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("manual");
        expect(
          yield* acceptanceRequestAdmitted({
            boundary: "ingress",
            request,
            now: yield* Clock.currentTimeMillis,
            environment: {
              BROWSER_ORIGIN: browser,
              NATIVE_STORAGE_ADMISSION: "closed",
              RECOVERY_ISOLATION: "isolated",
              RELEASE_GIT_SHA: pair.revision,
              SMOKE_PROOF: pair.proof,
            },
          })
        ).toBe(true);
        const headers = new Headers(request.headers);
        headers.delete("x-fidy-acceptance-proof");
        headers.delete("traceparent");
        headers.delete("b3");

        return {
          headers: Object.fromEntries(headers),
          body: request.body === null ? null : yield* Effect.tryPromise(() => request.text()),
        };
      });

      const calls: Array<Effect.Success<ReturnType<typeof wire>>> = [];
      const client = Context.get(yield* Layer.build(ReleaseHttpLive), HttpClient.HttpClient);
      const run = Effect.runPromiseWith(yield* Effect.context<never>());

      const receive: typeof fetch = Object.assign(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ): Promise<Response> =>
          run(wire(new Request(input, init))).then((received) => {
            calls.push(received);

            return new Response("private response", { status: 503 });
          }),
        { preconnect: globalThis.fetch.preconnect }
      );

      const send = (request: Request): ReturnType<ReturnType<typeof acceptanceSend>> =>
        acceptanceSend(client)(request).pipe(Effect.provideService(FetchHttpClient.Fetch, receive));

      yield* controlsDigest(pair, send).pipe(Effect.ignore);

      yield* Effect.forEach(
        ["json", "empty"] as const,
        Effect.fnUntraced(function* (body) {
          expect(yield* observePairingStart(pair, body, send)).toBe("HTTP 503");
        }),
        { discard: true }
      );

      yield* controlsDigest(pair, (request) =>
        bufferedAcceptanceSend(client)(request).pipe(
          Effect.provideService(FetchHttpClient.Fetch, receive)
        )
      ).pipe(Effect.ignore);
      expect(calls).toHaveLength(4);
      expect(calls[3]).toEqual(calls[0]);
      expect(calls[0]?.body).toBe("{}");
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toEqual({ ...calls[0], body: null });
    }).pipe(Effect.scoped)
);

it.effect(
  "requires signed financial reads to succeed and both unsigned reads to return the closed status",
  () =>
    Effect.gen(function* () {
      const pair = {
        revision: "b".repeat(40),
        proof: "0".repeat(64),
        ingress: "11111111-1111-4111-8111-111111111111",
        core: "22222222-2222-4222-8222-222222222222",
      };

      const origin = installedOrigins.acceptance.api;

      const cookieHeaders = (name: string): HeadersInit => ({
        "set-cookie": name + "=test; Path=/; Secure; HttpOnly; SameSite=Lax",
      });

      yield* Effect.forEach(
        [
          [200, 503, "180908d13917383f405a0ece55ff98c32294fe42c5396a612d1606b95f50f2c5"],
          [503, 503, "Retained control refused at transaction history, HTTP 503"],
          [200, 200, "Closed acceptance expected HTTP 503; received 200"],
        ] as const,
        Effect.fnUntraced(function* ([signed, unsigned, expected]) {
          const ids = [pair.ingress, pair.core];

          const responses: ControlResponses = new Map(
            Object.entries({
              "/web/pairings": () =>
                Response.json({
                  pairingId: "pairing",
                  privateVerifier: "private",
                  expiresAt: "2026-11-20T00:00:00.000Z",
                }),
              "/web/providers/google/start": () =>
                Response.json(
                  {
                    authorizationUrl:
                      "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" +
                      encodeURIComponent(origin + "/providers/google/callback"),
                  },
                  { headers: cookieHeaders("__Host-fidy_google") }
                ),
              "/providers/google/callback": () => new Response(null, { status: 303 }),
              "/web/providers/google/status": () => Response.json({ status: "verified" }),
              "/web/providers/google/complete": () => Response.json({ status: "approved" }),
              "/web/pairings/redeem": () =>
                new Response(null, { headers: cookieHeaders("__Host-fidy_session") }),
              "/web/session/binding": () => Response.json({ binding: "test" }),
              "/web/consent/authorization": () =>
                Response.json({
                  authorization: {
                    reference: pair.ingress,
                    acceptedAtMs: 1000,
                    disclosure: webSignupDisclosure(),
                  },
                }),
              "/transactions": (request) =>
                Response.json(
                  { data: [], next: [] },
                  { status: request.headers.has(acceptanceProofHeader) ? signed : unsigned }
                ),
              "/user": () => Response.json({ data: { id: ids.shift() } }),
            })
          );

          const observed = yield* controlsDigest(pair, (request) =>
            serveControl(responses, request)
          ).pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: (value) => value })
          );

          expect(observed).toBe(expected);
        }),
        { discard: true }
      );
    })
);
