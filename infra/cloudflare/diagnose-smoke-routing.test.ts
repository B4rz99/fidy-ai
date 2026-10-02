import { Context, Effect, Exit, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { type RoutingObservation, diagnoseSmokeRouting } from "./diagnose-smoke-routing";
import { SmokeRequest, smokeDiagnosticRevision } from "../../apps/server/cloudflare/runtime/smoke";

const publicCandidate = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const publicStable = "db7cd8d3-4425-4fe7-8c81-01bf963b6067";
const coreCandidate = "f1161596-2645-4788-bc57-c6008b6418d1";
const coreStable = "39105473-af9c-4eec-8147-f14112775f77";
const digest = "a".repeat(64);
const config = {
  PUBLIC_VERSION_ID: publicCandidate,
  CORE_VERSION_ID: coreCandidate,
  STABLE_PUBLIC_VERSION_ID: publicStable,
  STABLE_CORE_VERSION_ID: coreStable,
  CONTRACT_DIGEST: digest,
  PUBLIC_WORKER_NAME: "fidy-public",
  CORE_WORKER_NAME: "fidy-core",
  SMOKE_PROOF: "b".repeat(64),
};
const runDiagnostic = (
  env: unknown,
  mockedFetch: typeof fetch
): Effect.Effect<
  ReadonlyArray<RoutingObservation>,
  Effect.Error<ReturnType<typeof diagnoseSmokeRouting>>
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(FetchHttpClient.layer);
      return yield* diagnoseSmokeRouting(env).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.provideService(FetchHttpClient.Fetch, mockedFetch),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
      );
    })
  );

const rejectedPostResponse = (
  request: Request,
  headers: Readonly<Record<string, string>>
): Promise<Response> =>
  request.text().then((text) => {
    const body = Schema.decodeSync(Schema.fromJsonString(SmokeRequest))(text);
    expect(body.expectedGitRevision).toBe(smokeDiagnosticRevision);
    expect(body.expectedCoreVersionId).toBe(coreStable);
    return new Response("secret-response-body", {
      status: 503,
      headers: {
        ...headers,
        "x-fidy-smoke-failure": "identity",
        "x-fidy-smoke-identity": "101",
        // Exercise equality-based identification for the older stable Core.
        "x-fidy-smoke-core-version": "secret-provider-value",
      },
    });
  });

describe("read-only smoke routing diagnosis", () => {
  it(
    "distinguishes candidate GET from stable POST with matched URLs and overrides and only refused diagnostic bodies",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const requests: Request[] = [];
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            const intermediate =
              request.headers
                .get("cloudflare-workers-version-overrides")
                ?.includes(publicStable) === true;
            const publicVersion = intermediate ? publicStable : publicCandidate;
            const headers = {
              "cache-control": "no-store",
              "x-fidy-smoke-worker-version": publicVersion,
            };
            if (request.method === "POST") {
              return rejectedPostResponse(request, headers);
            }
            return Promise.resolve(
              Response.json(
                {
                  status: "pending",
                  public: {
                    gitRevision: "c".repeat(40),
                    contractDigest: digest,
                    workerVersionId: publicVersion,
                  },
                  core: {
                    gitRevision: "d".repeat(40),
                    contractDigest: digest,
                    workerVersionId: coreCandidate,
                  },
                  manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
                  extra: "secret-response-body",
                },
                { headers }
              )
            );
          });
          try {
            const observations = yield* runDiagnostic(config, mockedFetch);
            expect(observations).toHaveLength(24);
            expect(
              observations
                .filter((value) => value.method === "GET")
                .every(
                  (value) => value.coreVersion === coreCandidate && value.coreSource === "body"
                )
            ).toBe(true);
            expect(
              observations
                .filter((value) => value.method === "POST")
                .every(
                  (value) => value.coreVersion === coreStable && value.coreSource === "equality"
                )
            ).toBe(true);
            for (let index = 0; index < requests.length; index += 2) {
              expect(requests[index]?.url).toBe(requests[index + 1]?.url);
              expect(requests[index]?.headers.get("cloudflare-workers-version-overrides")).toBe(
                requests[index + 1]?.headers.get("cloudflare-workers-version-overrides")
              );
            }
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              observations
            );
            expect(encoded).not.toContain("secret");
            expect(encoded).not.toContain(config.SMOKE_PROOF);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      ),
    15_000
  );

  it("refuses incomplete capture configuration before issuing any probe", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mockedFetch = vi.spyOn(globalThis, "fetch");
        try {
          const exit = yield* Effect.exit(
            runDiagnostic({ ...config, STABLE_CORE_VERSION_ID: "foreign-text" }, mockedFetch)
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(mockedFetch).not.toHaveBeenCalled();
        } finally {
          mockedFetch.mockRestore();
        }
      })
    ));

  it(
    "bounds response bytes and never promotes an oversized GET into an identity observation",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            return Promise.resolve(
              request.method === "GET"
                ? new Response("x".repeat(4097), { status: 200 })
                : new Response(null, {
                    status: 503,
                    headers: {
                      "x-fidy-smoke-failure": "identity",
                      "x-fidy-smoke-core-version": coreCandidate,
                    },
                  })
            );
          });
          try {
            const observations = yield* runDiagnostic(config, mockedFetch);
            expect(
              observations
                .filter((value) => value.method === "GET")
                .every((value) => value.coreVersion === "unavailable")
            ).toBe(true);
            expect(
              observations
                .filter((value) => value.method === "POST")
                .every(
                  (value) => value.coreVersion === coreCandidate && value.coreSource === "header"
                )
            ).toBe(true);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      ),
    15_000
  );
});
