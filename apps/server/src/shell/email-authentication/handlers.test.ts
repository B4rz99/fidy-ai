import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ApiHarness } from "~/shell/testing/api-harness";

const malformedVerification = Effect.fn("Testing.malformedEmailVerification")(function* (
  origin?: string
) {
  const request = HttpClientRequest.post("/web/onboarding/email/verify").pipe(
    HttpClientRequest.setBody(HttpBody.text("{}", "application/json"))
  );
  return yield* HttpClient.execute(
    origin === undefined ? request : HttpClientRequest.setHeader(request, "origin", origin)
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "email verification HTTP boundary",
  (it) => {
    it.effect("rejects proof consumption without a browser Origin", () =>
      Effect.gen(function* () {
        expect((yield* malformedVerification()).status).toBe(400);
      })
    );

    it.effect("rejects proof consumption from a cross origin before route behavior", () =>
      Effect.gen(function* () {
        expect((yield* malformedVerification("https://attacker.example")).status).toBe(403);
      })
    );

    it.effect("admits the configured exact Origin to generic payload validation", () =>
      Effect.gen(function* () {
        expect((yield* malformedVerification("https://fidyapp.com")).status).toBe(400);
      })
    );
  }
);
