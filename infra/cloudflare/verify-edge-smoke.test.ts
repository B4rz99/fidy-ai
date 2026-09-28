import { Effect } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { verifyEdgeSmoke } from "./verify-edge-smoke";

const safeHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const respond = (
  status: number,
  headers: HeadersInit = safeHeaders
): Readonly<{ status: number; headers: Headers }> => ({
  status,
  headers: new Headers(headers),
});

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
          ["/categories", 401],
          ["/providers/kapso/callback", 401],
          ["/providers/wompi/billing-events", 400],
          ["/web/hosted-turns", 403],
        ]);
        yield* verifyEdgeSmoke((input) => {
          observed.push(input);
          return Effect.succeed(respond(statuses.get(input.path) ?? 404));
        });
        expect(observed).toEqual([
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
          const result = yield* Effect.exit(verifyEdgeSmoke(() => Effect.succeed(response)));
          expect(result._tag).toBe("Failure");
        }
      })
  );
});
