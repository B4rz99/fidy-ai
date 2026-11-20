import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Effect } from "effect";
import { controlsDigest, observePairingStart } from "./native-fallback-probe";
import { acceptanceRequestAdmitted } from "../../apps/server/cloudflare/release-isolation/operations";
import { installedOrigins } from "@fidy/server/browser-transport";
import { releaseFailureMessage } from "./production-release";

it.effect(
  "distinguishes the canonical pairing refusal while withholding unrecognized provider bytes",
  () =>
    Effect.gen(function* () {
      const refusal =
        '{"error":{"code":"unavailable","message":"The operation is unavailable. Retry later."},"next":[]}';
      for (const body of [refusal, "private error detail", refusal + "private error detail"]) {
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
      }
    })
);

it.effect("compares the ordinary protected pairing request with a separately authenticated empty POST", () =>
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
      expect(yield* acceptanceRequestAdmitted({
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
      })).toBe(true);
      const headers = new Headers(request.headers);
      headers.delete("x-fidy-acceptance-proof");
      return { headers: Object.fromEntries(headers), body: request.body === null ? null : yield* Effect.promise(() => request.text()) };
    });
    const calls: Array<Effect.Success<ReturnType<typeof wire>>> = [];
    const send = Effect.fn(function* (request: Request) {
      calls.push(yield* wire(request));
      return new Response("private response", { status: 503 });
    });
    yield* controlsDigest(pair, send).pipe(Effect.ignore);
    for (const body of ["{}", null] as const) {
      expect(yield* observePairingStart(pair, body, send)).toBe("HTTP 503");
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body).toBe("{}");
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual({ ...calls[0], body: null });
  })
);
