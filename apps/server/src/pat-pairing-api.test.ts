import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { HttpApiClient, OpenApi } from "effect/unstable/httpapi";
import {
  PATPairingApi,
  PATPairingPollingRateLimitedApi,
  PATPairingRateLimitedApi,
  patPairingUnavailableBody,
} from "./pat-pairing-api";

const proof = { pairingId: "pairing", privateDeviceCode: "private-proof" };
const sourceRefusal =
  '{"error":{"code":"rate_limited","message":"PAT pairing is temporarily unavailable. Try again later."}}';

describe("PAT pairing claim contract", () => {
  it.effect("decodes source admission refusal as a declared claim failure", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.makeWith(PATPairingApi, {
        baseUrl: "https://example.test",
        httpClient: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(sourceRefusal, {
                status: 429,
                headers: { "content-type": "application/json" },
              })
            )
          )
        ),
      });
      const failure = yield* Effect.flip(client.patPairing.claim({ payload: proof }));
      expect(failure).toBeInstanceOf(PATPairingRateLimitedApi);
      expect(failure).toMatchObject(patPairingUnavailableBody);
      const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(sourceRefusal);
      expect(Schema.decodeUnknownOption(PATPairingRateLimitedApi)(raw)._tag).toBe("Some");
      expect(
        Schema.decodeUnknownOption(PATPairingRateLimitedApi)({
          error: { code: "rate_limited", message: "unexpected" },
        })._tag
      ).toBe("None");
    })
  );

  it("publishes distinct polling and source admission bodies for claim's 429 response", () => {
    const spec = OpenApi.fromApi(PATPairingApi);
    const claim = spec.paths["/pat-pairings/claim"];
    if (claim?.post === undefined) throw new Error("PAT pairing claim must be published");
    const response = claim.post.responses["429"];
    expect(JSON.stringify(response)).toContain("PATPairingPollingRateLimitedApiEncoded");
    expect(JSON.stringify(response)).toContain("PATPairingRateLimitedApiEncoded");
    expect(
      JSON.stringify(spec.components.schemas.PATPairingPollingRateLimitedApiEncoded)
    ).toContain("retryAfterSeconds");
    expect(JSON.stringify(spec.components.schemas.PATPairingRateLimitedApiEncoded)).toContain(
      "temporarily unavailable"
    );
    expect(
      Schema.decodeUnknownOption(PATPairingPollingRateLimitedApi)(patPairingUnavailableBody)._tag
    ).toBe("None");
  });
});
