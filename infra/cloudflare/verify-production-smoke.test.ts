import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyProductionSmoke, verifyPromotedSmoke } from "./verify-production-smoke";

const revision = "0123456789abcdef0123456789abcdef01234567";
const previousRevision = "fedcba9876543210fedcba9876543210fedcba98";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const publicCandidate = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const publicStable = "db7cd8d3-4425-4fe7-8c81-01bf963b6067";
const coreCandidate = "f1161596-2645-4788-bc57-c6008b6418d1";
const config = {
  RELEASE_GIT_SHA: revision,
  CONTRACT_DIGEST: digest,
  PUBLIC_VERSION_ID: publicCandidate,
  CORE_VERSION_ID: coreCandidate,
  STABLE_PUBLIC_VERSION_ID: publicStable,
  STABLE_RELEASE_GIT_SHA: previousRevision,
  STABLE_CONTRACT_DIGEST: digest,
  PUBLIC_WORKER_NAME: "fidy-public",
  CORE_WORKER_NAME: "fidy-core",
  SMOKE_PROOF: "a".repeat(64),
};
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const recordingResponse = (input: {
  request: Request;
  bodies: string[];
  response: Response;
}): Promise<Response> =>
  input.request.text().then((body) => {
    input.bodies.push(body);
    return input.response;
  });

/** A wrong public version in the second smoke must never generate a passing release gate. */
describe("intermediate production smoke", () => {
  it.each([403, 503])("refuses HTTP %i without retrying synthetic work", (status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
          Promise.resolve(
            new Response(null, {
              status,
              headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicStable },
            })
          )
        );
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(FetchHttpClient.layer);
            return yield* Effect.exit(
              verifyProductionSmoke(config).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(services, HttpClient.HttpClient)
                ),
                Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
              )
            );
          })
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        mockedFetch.mockRestore();
      })
    )
  );
  it.each(["admission", "secret-provider-body"])(
    "reports only an owned smoke failure stage (%s)",
    (stage) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
            Promise.resolve(
              new Response(null, {
                status: 503,
                headers: {
                  ...securityHeaders,
                  "x-fidy-smoke-worker-version": publicCandidate,
                  "x-fidy-smoke-failure": stage,
                },
              })
            )
          );
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(FetchHttpClient.layer);
              return yield* Effect.exit(
                verifyProductionSmoke(config).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(services, HttpClient.HttpClient)
                  ),
                  Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
                )
              );
            })
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) {
              const reason =
                "reason" in error.value ? String(error.value.reason) : String(error.value);
              if (stage === "admission") expect(reason).toContain("stage=admission");
              expect(reason).not.toContain("secret-provider-body");
            }
          }
          expect(mockedFetch).toHaveBeenCalledTimes(1);
          mockedFetch.mockRestore();
        })
      )
  );

  it("waits for candidate routing to converge without accepting fallback or changing the probe identity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bodies: string[] = [];
        let firstCandidate = true;
        const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const override = request.headers.get("cloudflare-workers-version-overrides") ?? "";
          const oldPublic = override.includes(`fidy-public="${publicStable}"`);
          if (path === "/internal/release-smoke") {
            const fallback = firstCandidate;
            firstCandidate = false;
            const observed = fallback || oldPublic ? publicStable : publicCandidate;
            const response = Response.json(
              {
                status: "passed",
                public: {
                  gitRevision: fallback || oldPublic ? previousRevision : revision,
                  contractDigest: digest,
                  workerVersionId: observed,
                },
                core: {
                  gitRevision: revision,
                  contractDigest: digest,
                  workerVersionId: coreCandidate,
                },
                manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
              },
              {
                status: 202,
                headers: { ...securityHeaders, "x-fidy-smoke-worker-version": observed },
              }
            );
            return recordingResponse({ request, bodies, response });
          }
          const status =
            new Map([
              ["/health", 200],
              ["/categories", 401],
              ["/providers/kapso/callback", 401],
              ["/providers/wompi/billing-events", 400],
              ["/web/hosted-turns", 403],
            ]).get(path) ?? 404;
          return Promise.resolve(
            new Response(null, {
              status,
              headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicCandidate },
            })
          );
        });
        try {
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(FetchHttpClient.layer);
              return yield* Effect.exit(
                verifyProductionSmoke(config).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(services, HttpClient.HttpClient)
                  ),
                  Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
                )
              );
            })
          );
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(bodies).toHaveLength(3);
          expect(bodies[1]).toBe(bodies[0]);
        } finally {
          mockedFetch.mockRestore();
        }
      })
    ));
  it(
    "refuses a stable-public override that actually reaches another public Worker",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const calls: string[] = [];
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            const override = request.headers.get("cloudflare-workers-version-overrides") ?? "";
            const oldPublic = override.includes(`fidy-public="${publicStable}"`);
            if (path === "/internal/release-smoke") {
              calls.push(oldPublic ? "old-public/new-Core" : "new-public/new-Core");
              return Promise.resolve(
                Response.json(
                  {
                    status: "passed",
                    public: {
                      gitRevision: oldPublic ? previousRevision : revision,
                      contractDigest: digest,
                      workerVersionId: publicCandidate, // The old public's override was ignored
                    },
                    core: {
                      gitRevision: revision,
                      contractDigest: digest,
                      workerVersionId: coreCandidate,
                    },
                    manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
                  },
                  {
                    headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicCandidate },
                  }
                )
              );
            }
            const status =
              new Map([
                ["/health", 200],
                ["/categories", 401],
                ["/providers/kapso/callback", 401],
                ["/providers/wompi/billing-events", 400],
                ["/web/hosted-turns", 403],
              ]).get(path) ?? 404;
            return Promise.resolve(
              new Response(null, {
                status,
                headers: {
                  ...securityHeaders,
                  "x-fidy-smoke-worker-version": request.headers.has("x-fidy-smoke-proof")
                    ? publicCandidate
                    : publicStable,
                },
              })
            );
          });
          try {
            const exit = yield* Effect.scoped(
              Effect.gen(function* () {
                const services = yield* Layer.build(FetchHttpClient.layer);
                return yield* Effect.exit(
                  verifyProductionSmoke(config).pipe(
                    Effect.provideService(FetchHttpClient.Fetch, mockedFetch),
                    Effect.provideService(
                      HttpClient.HttpClient,
                      Context.get(services, HttpClient.HttpClient)
                    ),
                    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
                  )
                );
              })
            );
            expect(calls).toEqual([
              "new-public/new-Core",
              ...Array.from({ length: 7 }, () => "old-public/new-Core"),
            ]);
            expect(Exit.isFailure(exit)).toBe(true);
          } finally {
            mockedFetch.mockClear();
          }
        })
      ),
    15_000
  );
});

afterAll(() => vi.restoreAllMocks());

describe("post-promotion production smoke", () => {
  it("refuses a healthy version override when normal traffic still reaches stable code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Request[] = [];
        const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Promise.resolve(
            Response.json(
              {
                status: "passed",
                public: {
                  gitRevision: previousRevision,
                  contractDigest: digest,
                  workerVersionId: publicStable,
                },
                core: {
                  gitRevision: revision,
                  contractDigest: digest,
                  workerVersionId: coreCandidate,
                },
                manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
              },
              { headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicStable } }
            )
          );
        });
        try {
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(FetchHttpClient.layer);
              return yield* Effect.exit(
                verifyPromotedSmoke(config).pipe(
                  Effect.provideService(FetchHttpClient.Fetch, mockedFetch),
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(services, HttpClient.HttpClient)
                  ),
                  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
                )
              );
            })
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(requests).toHaveLength(1);
          expect(requests[0]?.headers.has("cloudflare-workers-version-overrides")).toBe(false);
        } finally {
          mockedFetch.mockClear();
        }
      })
    ));
});
