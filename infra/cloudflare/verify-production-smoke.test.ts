import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { SmokeRequest } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyCandidateSmoke,
  verifyProductionSmoke,
  verifyPromotedSmoke,
  verifyReadOnlySmokeRouting,
} from "./verify-production-smoke";

afterEach(() => vi.restoreAllMocks());

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

const gatedResponse = (
  ready: Promise<void>,
  input: Parameters<typeof recordingResponse>[0]
): Promise<Response> => ready.then(() => recordingResponse(input));

const intermediateRequest = (request: Request): boolean =>
  (request.headers.get("cloudflare-workers-version-overrides") ?? "").includes(
    `fidy-public="${publicStable}"`
  );

const pairingResponse = (
  input: {
    oldPublic: boolean;
    coreRevision: string;
    readiness: boolean;
  },
  padding: Option.Option<string> = Option.none()
): Response => {
  const publicVersion = input.oldPublic ? publicStable : publicCandidate;
  return Response.json(
    {
      status: input.readiness ? "pending" : "passed",
      public: {
        gitRevision: input.oldPublic ? previousRevision : revision,
        contractDigest: digest,
        workerVersionId: publicVersion,
      },
      core: {
        gitRevision: input.coreRevision,
        contractDigest: digest,
        workerVersionId: coreCandidate,
      },
      manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
      ...Option.match(padding, { onNone: () => ({}), onSome: (value) => ({ padding: value }) }),
    },
    { headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicVersion } }
  );
};
const edgeResponse = (request: Request): Response => {
  const path = new URL(request.url).pathname;
  const status =
    new Map([
      ["/health", 200],
      ["/categories", 401],
      ["/providers/kapso/callback", 401],
      ["/providers/wompi/billing-events", 400],
      ["/web/hosted-turns", 403],
      ["/.well-known/oauth-protected-resource/mcp", 200],
      ["/.well-known/oauth-authorization-server", 200],
      ["/oauth/authorize", 400],
      ["/oauth/register", 400],
      ["/oauth/token", 400],
      ["/web/oauth/review", 403],
      ["/web/oauth/connect", 403],
      ["/mcp", request.headers.has("origin") ? 403 : 401],
    ]).get(path) ?? 404;
  const headers = new Headers({
    ...securityHeaders,
    "x-fidy-smoke-worker-version": publicCandidate,
  });
  if (path === "/mcp" && status === 401) {
    headers.set(
      "www-authenticate",
      'Bearer resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp", scope="read"'
    );
  }
  return new Response(null, { status, headers });
};

const heldSmokeBody = (
  response: Response,
  cancelled: () => void,
  onRead: () => void = () => undefined
): Promise<Response> =>
  response.arrayBuffer().then(
    (bytes) =>
      new Response(
        new ReadableStream({
          start(controller): void {
            controller.enqueue(new Uint8Array(bytes));
          },
          pull(): void {
            onRead();
          },
          cancel(): void {
            cancelled();
          },
        }),
        { headers: response.headers }
      )
  );
for (const phase of ["readiness", "synthetic"] as const) {
  for (const hostileBody of ["overflow", "malformed"] as const) {
    it(
      `withholds attestation and further work after ${hostileBody} ${phase} bytes`,
      () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              let attested = false;
              let syntheticCalls = 0;
              const mockedFetch = vi
                .spyOn(globalThis, "fetch")
                .mockImplementation((input, init) => {
                  const request = new Request(input, init);
                  if (request.method === "POST") syntheticCalls++;
                  return Promise.resolve(
                    new Response(
                      hostileBody === "overflow" ? "x".repeat(4097) : "private-provider-body",
                      {
                        headers: {
                          ...securityHeaders,
                          "x-fidy-smoke-worker-version": intermediateRequest(request)
                            ? publicStable
                            : publicCandidate,
                        },
                      }
                    )
                  );
                });
              try {
                const services = yield* Layer.build(FetchHttpClient.layer);
                const exit = yield* Effect.exit(
                  (phase === "readiness"
                    ? verifyCandidateSmoke(config)
                    : verifyProductionSmoke(config)
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        attested = true;
                      })
                    ),
                    Effect.provideService(
                      HttpClient.HttpClient,
                      Context.get(services, HttpClient.HttpClient)
                    ),
                    Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
                  )
                );
                expect(Exit.isFailure(exit)).toBe(true);
                expect(attested).toBe(false);
                if (phase === "readiness") expect(syntheticCalls).toBe(0);
                const error = Exit.isFailure(exit)
                  ? Cause.findErrorOption(exit.cause)
                  : Option.none();
                expect(
                  Option.isSome(error) && "reason" in error.value && error.value.reason
                ).not.toContain("private-provider-body");
              } finally {
                mockedFetch.mockRestore();
              }
            })
          )
        ),
      40_000
    );
  }
}

const routingModes = ["candidate", "intermediate", "promoted"] as const;

effectIt.effect.each([undefined, "1"])(
  "rejects an oversized streaming smoke response despite declared length %s",
  (declaredLength) =>
    Effect.gen(function* () {
      let cancelled = false;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        const response = pairingResponse(
          {
            oldPublic: intermediateRequest(request),
            coreRevision: revision,
            readiness: false,
          },
          Option.some("x".repeat(32 * 1024))
        );
        if (declaredLength !== undefined) response.headers.set("content-length", declaredLength);
        return heldSmokeBody(response, () => {
          cancelled = true;
        });
      });
      const services = yield* Layer.build(FetchHttpClient.layer);
      const exit = yield* verifyProductionSmoke(config).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(Predicate.isTagged(failure, "ReleaseSmokeFailed")).toBe(true);
        if (Predicate.isTagged(failure, "ReleaseSmokeFailed")) {
          expect(failure.reason).toContain("byte budget");
        }
      }
      expect(cancelled).toBe(true);
    }).pipe(Effect.scoped)
);

effectIt.effect(
  "times out total synthetic response work after headers without waiting indefinitely for EOF",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let cancelled = false;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        const response = pairingResponse({
          oldPublic: intermediateRequest(request),
          coreRevision: revision,
          readiness: false,
        });
        return heldSmokeBody(
          response,
          () => {
            cancelled = true;
          },
          () => {
            Deferred.doneUnsafe(ready, Effect.void);
          }
        );
      });
      const services = yield* Layer.build(FetchHttpClient.layer);
      const fiber = yield* verifyProductionSmoke(config).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit,
        Effect.forkScoped
      );
      yield* Deferred.await(ready);
      yield* TestClock.adjust("8 seconds");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(Predicate.isTagged(failure, "ReleaseSmokeFailed")).toBe(true);
        if (Predicate.isTagged(failure, "ReleaseSmokeFailed")) {
          expect(failure.reason).toContain("total deadline");
        }
      }
      expect(cancelled).toBe(true);
    }).pipe(Effect.scoped)
);

describe("read-only routing readiness", () => {
  it("starts neither synthetic pairing until old ingress also reaches the exact candidate Core", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let intermediateReady = false;
          let intermediateReads = 0;
          const probes: string[] = [];
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            const oldPublic = intermediateRequest(request);
            if (url.pathname !== "/internal/release-smoke") {
              return Promise.resolve(edgeResponse(request));
            }
            const readiness = url.searchParams.get("readiness") === "1";
            if (readiness && oldPublic) {
              intermediateReads++;
              intermediateReady = intermediateReads > 1;
            }
            if (!readiness) {
              expect(intermediateReady).toBe(true);
              expect(request.method).toBe("POST");
              probes.push(oldPublic ? "intermediate" : "candidate");
            }
            return Promise.resolve(
              pairingResponse({
                oldPublic,
                readiness,
                coreRevision: oldPublic && !intermediateReady ? previousRevision : revision,
              })
            );
          });
          try {
            const services = yield* Layer.build(FetchHttpClient.layer);
            yield* verifyCandidateSmoke(config).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                Context.get(services, HttpClient.HttpClient)
              ),
              Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
            );
            expect(intermediateReads).toBe(2);
            expect(probes.sort()).toEqual(["candidate", "intermediate"]);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      )
    ));
  it("blocks both synthetic pairings when intermediate readiness authority is refused", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            expect(request.method).toBe("GET");
            expect(new URL(request.url).searchParams.get("readiness")).toBe("1");
            const intermediate = intermediateRequest(request);
            return Promise.resolve(
              intermediate
                ? new Response(null, { status: 403, headers: securityHeaders })
                : Response.json(
                    {
                      status: "pending",
                      public: {
                        gitRevision: revision,
                        contractDigest: digest,
                        workerVersionId: publicCandidate,
                      },
                      core: {
                        gitRevision: revision,
                        contractDigest: digest,
                        workerVersionId: coreCandidate,
                      },
                      manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
                    },
                    {
                      headers: {
                        ...securityHeaders,
                        "x-fidy-smoke-worker-version": publicCandidate,
                      },
                    }
                  )
            );
          });
          try {
            const services = yield* Layer.build(FetchHttpClient.layer);
            const exit = yield* Effect.exit(
              verifyCandidateSmoke(config).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(services, HttpClient.HttpClient)
                ),
                Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
              )
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Cause.findErrorOption(exit.cause);
              expect(Option.isSome(error) && "reason" in error.value && error.value.reason).toBe(
                "Read-only intermediate Worker routing did not converge; no synthetic work started: Read-only routing authority refused"
              );
            }
            expect(mockedFetch).toHaveBeenCalledTimes(2);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      )
    ));
  it("refuses readiness authority without starting synthetic work", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            expect(request.method).toBe("GET");
            expect(new URL(request.url).searchParams.get("readiness")).toBe("1");
            return Promise.resolve(new Response(null, { status: 403, headers: securityHeaders }));
          });
          const services = yield* Layer.build(FetchHttpClient.layer);
          const exit = yield* Effect.exit(
            verifyReadOnlySmokeRouting(config).pipe(
              Effect.andThen(verifyProductionSmoke(config)),
              Effect.provideService(
                HttpClient.HttpClient,
                Context.get(services, HttpClient.HttpClient)
              ),
              Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
            )
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(mockedFetch).toHaveBeenCalledTimes(1);
          mockedFetch.mockRestore();
        })
      )
    ));
  it.each(routingModes)("waits for both Worker identities without synthetic work (%s)", (mode) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0;
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            expect(request.method).toBe("GET");
            expect(new URL(request.url).searchParams.get("readiness")).toBe("1");
            expect(request.headers.has("cloudflare-workers-version-overrides")).toBe(
              mode !== "promoted"
            );
            const expectedVersion = mode === "intermediate" ? publicStable : publicCandidate;
            if (mode !== "promoted") {
              expect(request.headers.get("cloudflare-workers-version-overrides")).toBe(
                `fidy-public="${expectedVersion}", fidy-core="${coreCandidate}"`
              );
            }
            attempts++;
            if (attempts === 1) {
              return Promise.resolve(new Response(null, { status: 503, headers: securityHeaders }));
            }
            return Promise.resolve(
              Response.json(
                {
                  status: "pending",
                  public: {
                    gitRevision: mode === "intermediate" ? previousRevision : revision,
                    contractDigest: digest,
                    workerVersionId: expectedVersion,
                  },
                  core: {
                    gitRevision: attempts === 2 ? previousRevision : revision,
                    contractDigest: digest,
                    workerVersionId: coreCandidate,
                  },
                  manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
                },
                { headers: { ...securityHeaders, "x-fidy-smoke-worker-version": expectedVersion } }
              )
            );
          });
          const services = yield* Layer.build(FetchHttpClient.layer);
          yield* verifyReadOnlySmokeRouting(config, mode).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              Context.get(services, HttpClient.HttpClient)
            ),
            Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
          );
          expect(attempts).toBe(3);
          mockedFetch.mockRestore();
        })
      )
    )
  );
});

/** A wrong public version in the second smoke must never generate a passing release gate. */
describe("intermediate production smoke", () => {
  effectIt.effect("reports the owned failing edge path without provider response content", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        const probe = new Request(request.url, {
          method: request.method,
          headers: request.headers,
        });
        const path = new URL(probe.url).pathname;
        let response = edgeResponse(probe);
        if (path === "/internal/release-smoke") {
          response = pairingResponse({
            oldPublic: intermediateRequest(probe),
            coreRevision: revision,
            readiness: false,
          });
        } else if (path === "/.well-known/oauth-protected-resource/mcp") {
          response = new Response("secret-provider-body", { status: 503 });
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const exit = yield* Effect.exit(
        verifyProductionSmoke(config).pipe(Effect.provideService(HttpClient.HttpClient, client))
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(failure.reason).toContain("/.well-known/oauth-protected-resource/mcp");
        expect(failure.reason).not.toContain("secret-provider-body");
      }
    })
  );
  it.each([200, 503])(
    "overlaps isolated pairings and requires both to pass (intermediate HTTP %i)",
    (intermediateStatus) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const bodies: string[] = [];
          const pairings = new Set<string>();
          const bothStarted = Promise.withResolvers<void>();
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            const override = request.headers.get("cloudflare-workers-version-overrides") ?? "";
            const oldPublic = override.includes(`fidy-public="${publicStable}"`);
            if (path === "/internal/release-smoke") {
              const publicVersion = oldPublic ? publicStable : publicCandidate;
              pairings.add(publicVersion);
              if (pairings.size === 2) bothStarted.resolve();
              const response = Response.json(
                {
                  status: "passed",
                  public: {
                    gitRevision: oldPublic ? previousRevision : revision,
                    contractDigest: digest,
                    workerVersionId: publicVersion,
                  },
                  core: {
                    gitRevision: revision,
                    contractDigest: digest,
                    workerVersionId: coreCandidate,
                  },
                  manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
                },
                {
                  status: oldPublic ? intermediateStatus : 200,
                  headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicVersion },
                }
              );
              // Sequential smoke deadlocks here instead of accidentally passing a timing assertion.
              return gatedResponse(bothStarted.promise, { request, bodies, response });
            }
            return Promise.resolve(edgeResponse(request));
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
                    Effect.timeout("1 second")
                  )
                );
              })
            );
            expect(Exit.isSuccess(exit)).toBe(intermediateStatus === 200);
            expect(pairings.size).toBe(2);
            const probes = yield* Effect.forEach(bodies, (body) =>
              Schema.decodeEffect(Schema.fromJsonString(SmokeRequest))(body)
            );
            expect(probes).toHaveLength(2);
            expect(new Set(probes.map((probe) => probe.probeId)).size).toBe(2);
            expect(probes.every((probe) => probe.expectedCoreVersionId === coreCandidate)).toBe(
              true
            );
          } finally {
            bothStarted.resolve();
            mockedFetch.mockRestore();
          }
        })
      )
  );
  it("replays the same intermediate probe after a pre-admission Core identity rejection", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bodies: string[] = [];
          let rejected = false;
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (path !== "/internal/release-smoke") return Promise.resolve(edgeResponse(request));
            const oldPublic = intermediateRequest(request);
            const reject = oldPublic && !rejected;
            if (reject) rejected = true;
            return recordingResponse({
              request,
              bodies,
              response: reject
                ? new Response(null, {
                    status: 503,
                    headers: {
                      ...securityHeaders,
                      "x-fidy-smoke-worker-version": publicStable,
                      "x-fidy-smoke-failure": "identity",
                      "x-fidy-smoke-identity": "001",
                    },
                  })
                : pairingResponse({ oldPublic, coreRevision: revision, readiness: false }),
            });
          });
          try {
            const services = yield* Layer.build(FetchHttpClient.layer);
            const exit = yield* Effect.exit(
              verifyProductionSmoke(config).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(services, HttpClient.HttpClient)
                ),
                Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
              )
            );
            expect(Exit.isSuccess(exit)).toBe(true);
            const intermediateBodies = bodies.filter((body) => body.includes(publicStable));
            expect(intermediateBodies).toHaveLength(2);
            expect(intermediateBodies[1]).toBe(intermediateBodies[0]);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      )
    ));

  it.each(["001", "secret-provider-body"])(
    "bounds persistent pre-admission identity retries and reports only equality bits (%s)",
    (equality) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bodies: string[] = [];
            const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
              const request = new Request(input, init);
              const path = new URL(request.url).pathname;
              if (path !== "/internal/release-smoke") return Promise.resolve(edgeResponse(request));
              const oldPublic = intermediateRequest(request);
              return recordingResponse({
                request,
                bodies,
                response: oldPublic
                  ? new Response(null, {
                      status: 503,
                      headers: {
                        ...securityHeaders,
                        "x-fidy-smoke-worker-version": publicStable,
                        "x-fidy-smoke-failure": "identity",
                        "x-fidy-smoke-identity": equality,
                      },
                    })
                  : pairingResponse({ oldPublic, coreRevision: revision, readiness: false }),
              });
            });
            try {
              const services = yield* Layer.build(FetchHttpClient.layer);
              const exit = yield* Effect.exit(
                verifyProductionSmoke(config).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(services, HttpClient.HttpClient)
                  ),
                  Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
                )
              );
              expect(Exit.isFailure(exit)).toBe(true);
              const intermediateBodies = bodies.filter((body) => body.includes(publicStable));
              expect(intermediateBodies).toHaveLength(7);
              expect(new Set(intermediateBodies).size).toBe(1);
              if (Exit.isFailure(exit)) {
                const error = Cause.findErrorOption(exit.cause);
                expect(
                  Option.isSome(error) && "reason" in error.value && error.value.reason
                ).toContain("intermediate pairing:");
                const reason =
                  Option.isSome(error) && "reason" in error.value ? error.value.reason : "";
                expect(reason).not.toContain("secret-provider-body");
                if (equality === "001") {
                  expect(reason).toContain(
                    "coreVersion=false, coreRevision=false, coreDigest=true"
                  );
                }
              }
            } finally {
              mockedFetch.mockRestore();
            }
          })
        )
      ),
    15_000
  );

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
        expect(mockedFetch).toHaveBeenCalledTimes(2);
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
          expect(mockedFetch).toHaveBeenCalledTimes(2);
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
          return Promise.resolve(edgeResponse(request));
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
          const candidateBodies = bodies.filter((body) => body.includes(publicCandidate));
          expect(candidateBodies).toHaveLength(2);
          expect(candidateBodies[1]).toBe(candidateBodies[0]);
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
            const response = edgeResponse(request);
            response.headers.set(
              "x-fidy-smoke-worker-version",
              request.headers.has("x-fidy-smoke-proof") ? publicCandidate : publicStable
            );
            return Promise.resolve(response);
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
  it("does not retry a Core identity rejection on normal traffic", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
            Promise.resolve(
              new Response(null, {
                status: 503,
                headers: {
                  ...securityHeaders,
                  "x-fidy-smoke-worker-version": publicCandidate,
                  "x-fidy-smoke-failure": "identity",
                  "x-fidy-smoke-identity": "001",
                },
              })
            )
          );
          try {
            const services = yield* Layer.build(FetchHttpClient.layer);
            const exit = yield* Effect.exit(
              verifyPromotedSmoke(config).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(services, HttpClient.HttpClient)
                ),
                Effect.provideService(FetchHttpClient.Fetch, mockedFetch)
              )
            );
            expect(Exit.isFailure(exit)).toBe(true);
            expect(mockedFetch).toHaveBeenCalledTimes(1);
          } finally {
            mockedFetch.mockRestore();
          }
        })
      )
    ));
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
