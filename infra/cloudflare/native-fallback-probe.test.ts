import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { controlsDigest } from "./native-fallback-probe";
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
