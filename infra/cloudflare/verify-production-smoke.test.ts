import { Context, Effect, Exit, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { verifyProductionSmoke } from "./verify-production-smoke";

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

/** A wrong public version in the second smoke must never generate a passing release gate. */
describe("intermediate production smoke", () => {
  it("refuses a stable-public override that actually reaches another public Worker", async () => {
    const calls: string[] = [];
    const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const override = request.headers.get("cloudflare-workers-version-overrides") ?? "";
      const oldPublic = override.includes(`fidy-public="${publicStable}"`);
      if (path === "/internal/release-smoke") {
        calls.push(oldPublic ? "old-public/new-Core" : "new-public/new-Core");
        return Response.json(
          {
            status: "passed",
            public: {
              gitRevision: oldPublic ? previousRevision : revision,
              contractDigest: digest,
              workerVersionId: publicCandidate, // The old public's override was ignored
            },
            core: { gitRevision: revision, contractDigest: digest, workerVersionId: coreCandidate },
            manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
          },
          { headers: { ...securityHeaders, "x-fidy-smoke-worker-version": publicCandidate } }
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
      return new Response(null, {
        status,
        headers: {
          ...securityHeaders,
          "x-fidy-smoke-worker-version": request.headers.has("x-fidy-smoke-proof")
            ? publicCandidate
            : publicStable,
        },
      });
    });
    try {
      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(FetchHttpClient.layer);
            return yield* Effect.exit(
              verifyProductionSmoke(config).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(services, HttpClient.HttpClient)
                ),
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
              )
            );
          })
        )
      );
      expect(calls).toEqual(["new-public/new-Core", "old-public/new-Core"]);
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      mockedFetch.mockRestore();
    }
  });
});
