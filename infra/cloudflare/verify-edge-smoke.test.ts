import { Context, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { productionProbe, verifyEdgeSmoke } from "./verify-edge-smoke";

const safeHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const requestPath = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  input instanceof Request ? new URL(input.url).pathname : new URL(input).pathname;

const respond = (
  status: number,
  headers: HeadersInit = safeHeaders
): Readonly<{ status: number; headers: Headers }> => ({
  status,
  headers: new Headers(headers),
});

it.effect("aborts every unconsumed native edge response on success and mismatch", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(FetchHttpClient.layer);
    for (const mismatch of [false, true]) {
      const signals: AbortSignal[] = [];
      let pulled = 0;
      const statuses = new Map([
        ["/health", 200],
        ["/categories", 401],
        ["/providers/kapso/callback", 401],
        ["/providers/wompi/billing-events", 400],
        ["/web/hosted-turns", 403],
      ]);
      const fetch: typeof globalThis.fetch = Object.assign(
        (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ): Promise<Response> => {
          if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
          const path = requestPath(input);
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    pulled += 1;
                  },
                },
                { highWaterMark: 0 }
              ),
              { status: mismatch ? 503 : statuses.get(path), headers: safeHeaders }
            )
          );
        },
        { preconnect: globalThis.fetch.preconnect }
      );
      const outcome = yield* verifyEdgeSmoke({
        probe: productionProbe,
        candidate: Option.none(),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit
      );
      expect(Exit.isSuccess(outcome)).toBe(!mismatch);
      expect(signals).toHaveLength(mismatch ? 1 : 5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(pulled).toBe(0);
    }
  }).pipe(Effect.scoped)
);

describe("production edge smoke", () => {
  it.effect(
    "checks safe rejections on PAT, provider, and hosted browser paths without issuing valid authority",
    () =>
      Effect.gen(function* () {
        const observed: Array<{
          path: string;
          method: string;
          headers: Readonly<Record<string, string>>;
        }> = [];
        const statuses = new Map([
          ["/health", 200],
          ["/categories", 401],
          ["/providers/kapso/callback", 401],
          ["/providers/wompi/billing-events", 400],
          ["/web/hosted-turns", 403],
        ]);
        yield* verifyEdgeSmoke({
          probe: (input) => {
            observed.push(input);
            return Effect.succeed(respond(statuses.get(input.path) ?? 404));
          },
          candidate: Option.none(),
        });
        expect(observed).toEqual([
          { path: "/health", method: "GET", headers: {} },
          { path: "/categories", method: "GET", headers: {} },
          {
            path: "/providers/kapso/callback",
            method: "POST",
            headers: { "x-webhook-event": "whatsapp.message.delivered" },
          },
          { path: "/providers/wompi/billing-events", method: "POST", headers: {} },
          { path: "/web/hosted-turns", method: "POST", headers: {} },
        ]);
      })
  );

  it.effect(
    "rejects stable-version answers even when every protected route rejects correctly",
    () =>
      Effect.gen(function* () {
        const candidate = {
          proof: "a".repeat(64),
          override: 'public="dc8dcd28-271b-4367-9840-6c244f84cb40"',
          publicVersionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
        };
        const healthHasNoProof: Array<boolean> = [];
        const result = yield* Effect.exit(
          verifyEdgeSmoke({
            probe: ({ path, headers }) => {
              if (path === "/health") {
                healthHasNoProof.push(headers["x-fidy-smoke-proof"] === undefined);
              }
              return Effect.succeed(
                respond(path === "/health" ? 200 : 401, {
                  ...safeHeaders,
                  "x-fidy-smoke-worker-version": "db7cd8d3-4425-4fe7-8c81-01bf963b6067",
                })
              );
            },
            candidate: Option.some(candidate),
          })
        );
        expect(healthHasNoProof).toEqual([true]);
        expect(result._tag).toBe("Failure");
      })
  );

  it.effect("pins candidate health independently after a credential-free health check", () =>
    Effect.gen(function* () {
      const candidate = {
        proof: "a".repeat(64),
        override: 'public="dc8dcd28-271b-4367-9840-6c244f84cb40"',
        publicVersionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
      };
      const healthHeaders: Array<boolean> = [];
      const statuses = new Map([
        ["/health", 200],
        ["/categories", 401],
        ["/providers/kapso/callback", 401],
        ["/providers/wompi/billing-events", 400],
        ["/web/hosted-turns", 403],
      ]);
      const result = yield* Effect.exit(
        verifyEdgeSmoke({
          probe: ({ path, headers }) => {
            if (path === "/health") {
              healthHeaders.push(headers["x-fidy-smoke-proof"] === undefined);
            }
            const version =
              path === "/health"
                ? "db7cd8d3-4425-4fe7-8c81-01bf963b6067"
                : candidate.publicVersionId;
            return Effect.succeed(
              respond(statuses.get(path) ?? 404, {
                ...safeHeaders,
                "x-fidy-smoke-worker-version": version,
              })
            );
          },
          candidate: Option.some(candidate),
        })
      );
      expect(healthHeaders).toEqual([true, false]);
      expect(result._tag).toBe("Failure");
    })
  );

  it.effect("rejects a broken unauthenticated health route", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        verifyEdgeSmoke({ probe: () => Effect.succeed(respond(503)), candidate: Option.none() })
      );
      expect(result._tag).toBe("Failure");
    })
  );

  it.effect(
    "refuses unavailable configuration, browser challenges, redirects, and missing security headers",
    () =>
      Effect.gen(function* () {
        const challenges = [
          respond(503), // A missing required runtime binding must block promotion.
          respond(401, { ...safeHeaders, "cf-mitigated": "challenge" }),
          respond(302, { ...safeHeaders, location: "https://api.fidyapp.com/categories" }),
          respond(401, { "cache-control": "no-store" }),
        ];
        for (const response of challenges) {
          const result = yield* Effect.exit(
            verifyEdgeSmoke({ probe: () => Effect.succeed(response), candidate: Option.none() })
          );
          expect(result._tag).toBe("Failure");
        }
      })
  );
});
