import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { verifyStableWorkerIdentity } from "./stable-worker-identity";

const publicIdentity = {
  workerVersionId: "11111111-1111-4111-8111-111111111111",
  gitRevision: "a".repeat(40),
  contractDigest: "b".repeat(64),
};
const coreIdentity = { ...publicIdentity, workerVersionId: "22222222-2222-4222-8222-222222222222" };
const proof = "c".repeat(64);
const expected = { public: publicIdentity, core: coreIdentity, proof };
const readinessBody = {
  status: "pending",
  public: publicIdentity,
  core: coreIdentity,
  manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
};
const readinessClient = (body: unknown, status = 200): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.fidyapp.com");
    expect(request.headers["x-fidy-smoke-proof"]).toBe(proof);
    expect(request.headers["cloudflare-workers-version-overrides"]).toBeUndefined();
    const readOnly = request.method === "GET" && url.searchParams.get("readiness") === "1";
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(readOnly ? body : { status: "unavailable" }, {
          status: readOnly ? status : 503,
          headers: {
            "cache-control": "no-store",
            "x-fidy-smoke-worker-version": publicIdentity.workerVersionId,
          },
        })
      )
    );
  });

it.effect("captures stable identity without depending on synthetic publication availability", () =>
  Effect.gen(function* () {
    const outcome = yield* verifyStableWorkerIdentity(expected).pipe(
      Effect.provideService(HttpClient.HttpClient, readinessClient(readinessBody)),
      Effect.exit
    );
    expect(Exit.isSuccess(outcome)).toBe(true);
  })
);

for (const refusal of [
  { label: "wrong public version", body: { ...readinessBody, public: coreIdentity }, status: 200 },
  { label: "wrong Core version", body: { ...readinessBody, core: publicIdentity }, status: 200 },
  {
    label: "wrong Core revision",
    body: { ...readinessBody, core: { ...coreIdentity, gitRevision: "d".repeat(40) } },
    status: 200,
  },
  {
    label: "wrong contract",
    body: { ...readinessBody, public: { ...publicIdentity, contractDigest: "e".repeat(64) } },
    status: 200,
  },
  { label: "unavailable proof", body: {}, status: 404 },
  { label: "foreign refusal", body: { message: "private-provider-detail" }, status: 503 },
]) {
  it.effect(`refuses stable identity with ${refusal.label}`, () =>
    Effect.gen(function* () {
      const outcome = yield* verifyStableWorkerIdentity(expected).pipe(
        Effect.provideService(HttpClient.HttpClient, readinessClient(refusal.body, refusal.status)),
        Effect.exit
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(Cause.pretty(outcome.cause)).not.toContain("private-provider-detail");
        expect(Cause.pretty(outcome.cause)).not.toContain(proof);
      }
    })
  );
}
