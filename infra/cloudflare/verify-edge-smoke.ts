/// <reference types="bun-types" />

import { type Cause, Context, Data, Effect, Layer, Option } from "effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";

const apiOrigin = `https://${productionTopology.ingress.hostname}`;
const healthyStatus = 200;
const probes = [
  { method: "GET", path: "/health", expectedStatus: healthyStatus, headers: {} },
  { method: "GET", path: "/categories", expectedStatus: 401, headers: {} },
  {
    method: "POST",
    path: "/providers/kapso/callback",
    expectedStatus: 401,
    headers: { "x-webhook-event": "whatsapp.message.delivered" },
  },
  { method: "POST", path: "/providers/wompi/billing-events", expectedStatus: 400, headers: {} },
  { method: "POST", path: "/web/hosted-turns", expectedStatus: 403, headers: {} },
] as const;

type EdgeResponse = Readonly<{ status: number; headers: Headers }>;
type EdgeRequest = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
}>;
type Candidate = Readonly<{ proof: string; override: string; publicVersionId: string }>;
class EdgeSmokeFailure extends Data.TaggedError("EdgeSmokeFailure")<{
  readonly path: string;
}> {}

/** Probe credential-free health and rejected operations; never send a valid provider event or User request. */
export const verifyEdgeSmoke = <E, R>({
  probe,
  candidate,
}: Readonly<{
  probe: (input: EdgeRequest) => Effect.Effect<EdgeResponse, E, R>;
  candidate: Option.Option<Candidate>;
}>): Effect.Effect<void, EdgeSmokeFailure, R> =>
  Effect.gen(function* () {
    for (const entry of probes) {
      const response = yield* probe({
        method: entry.method,
        path: entry.path,
        headers: Option.isNone(candidate)
          ? entry.headers
          : {
              ...entry.headers,
              ...(entry.path === "/health" ? {} : { "x-fidy-smoke-proof": candidate.value.proof }),
              "cloudflare-workers-version-overrides": candidate.value.override,
            },
      }).pipe(Effect.mapError(() => new EdgeSmokeFailure({ path: entry.path })));
      if (
        !isExpectedResponse(response, entry.expectedStatus) ||
        !candidateResponseMatches(response, entry.path, candidate)
      ) {
        return yield* new EdgeSmokeFailure({ path: entry.path });
      }
    }
    if (Option.isSome(candidate)) yield* verifyCandidateHealth(probe, candidate.value);
  });

const candidateResponseMatches = (
  response: EdgeResponse,
  path: string,
  candidate: Option.Option<Candidate>
): boolean =>
  Option.isNone(candidate) ||
  path === "/health" ||
  response.headers.get("x-fidy-smoke-worker-version") === candidate.value.publicVersionId;

const verifyCandidateHealth = <E, R>(
  probe: (input: EdgeRequest) => Effect.Effect<EdgeResponse, E, R>,
  candidate: Candidate
): Effect.Effect<void, EdgeSmokeFailure, R> =>
  Effect.gen(function* () {
    // The reserved proof exposes version metadata, not private data.
    const health = yield* probe({
      method: "GET",
      path: "/health",
      headers: {
        "x-fidy-smoke-proof": candidate.proof,
        "cloudflare-workers-version-overrides": candidate.override,
      },
    }).pipe(Effect.mapError(() => new EdgeSmokeFailure({ path: "/health" })));
    if (
      !isExpectedResponse(health, healthyStatus) ||
      health.headers.get("x-fidy-smoke-worker-version") !== candidate.publicVersionId
    ) {
      return yield* new EdgeSmokeFailure({ path: "/health" });
    }
  });

const isExpectedResponse = (response: EdgeResponse, status: number): boolean =>
  response.status === status &&
  response.headers.get("cf-mitigated") === null &&
  Object.entries({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }).every(([name, expected]) => response.headers.get(name) === expected);

const productionProbe = ({
  method,
  path,
  headers,
}: EdgeRequest): Effect.Effect<
  EdgeResponse,
  HttpClientError.HttpClientError | Cause.TimeoutError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request =
      method === "GET"
        ? HttpClientRequest.get(`${apiOrigin}${path}`)
        : HttpClientRequest.post(`${apiOrigin}${path}`, {
            headers: { "content-type": "application/json", ...headers },
            body: HttpBody.text("{}", "application/json"),
          });
    const response = yield* client.execute(request);
    return { status: response.status, headers: new Headers(response.headers) };
  }).pipe(Effect.timeout("8 seconds"));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(FetchHttpClient.layer);
        return yield* verifyEdgeSmoke({ probe: productionProbe, candidate: Option.none() }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            Context.get(services, HttpClient.HttpClient)
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
        );
      })
    )
  );
  if (result._tag === "Failure") {
    await Bun.write(
      Bun.stderr,
      "Safe production edge probes failed; inspect edge configuration.\n"
    );
    process.exitCode = 1;
  } else {
    await Bun.write(Bun.stdout, "Safe production edge probes passed.\n");
  }
}
