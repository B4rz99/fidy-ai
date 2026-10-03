import { PATRecipientLabel, StartedPATPairing } from "@fidy/server/client";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makePairingClient } from "./runtime";

const secretCharacters = 43;
const pairing = Schema.decodeSync(Schema.toCodecJson(StartedPATPairing))({
  pairingId: "01900000-0000-4000-8000-000000000002",
  privateDeviceCode: "p".repeat(secretCharacters),
  publicCode: "BCDF-GHJK",
  expiresAt: "2026-10-03T00:10:00.000Z",
  pollingIntervalSeconds: 5,
});
const clientFor = (body: string, status: number): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": "application/json" } })
      )
    )
  );
const request = {
  recipientLabel: PATRecipientLabel.make("Mi agente"),
  scopes: ["read"],
  lifetimeDays: 7,
} as const;
const unavailableBody =
  '{"error":{"code":"rate_limited","message":"PAT pairing is temporarily unavailable. Try again later."}}';

it.effect(
  "keeps source admission, dependency unavailability and server polling delay distinct",
  () =>
    Effect.gen(function* () {
      const source = yield* makePairingClient(clientFor(unavailableBody, 429));
      expect(yield* Effect.result(source.start(request))).toMatchObject({
        failure: { reason: "SourceLimited" },
      });
      const dependency = yield* makePairingClient(clientFor(unavailableBody, 503));
      expect(yield* Effect.result(dependency.start(request))).toMatchObject({
        failure: { reason: "DependencyUnavailable" },
      });
      const slowdown = yield* makePairingClient(
        clientFor('{"error":{"code":"rate_limited","retryAfterSeconds":10}}', 429)
      );
      expect(yield* Effect.result(slowdown.claim(pairing))).toMatchObject({
        failure: { _tag: "PollingDelayed", retryAfterSeconds: 10 },
      });
    })
);

it.effect(
  "rejects invalid proof and treats a malformed claim response as ambiguous without redisclosure",
  () =>
    Effect.gen(function* () {
      const invalid = yield* makePairingClient(
        clientFor(
          '{"error":{"code":"pairing_invalid","message":"This PAT pairing is no longer valid. Start a new request."}}',
          400
        )
      );
      expect(yield* Effect.result(invalid.claim(pairing))).toMatchObject({
        failure: { reason: "PairingInvalid" },
      });
      const malformed = yield* makePairingClient(
        clientFor('{"bearer":"sensitive-unvalidated-value"}', 200)
      );
      const result = yield* Effect.result(malformed.claim(pairing));
      expect(result).toMatchObject({ failure: { reason: "ClaimAmbiguous" } });
      const diagnostic = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
      expect(diagnostic.includes("sensitive-unvalidated-value")).toBe(false);
    })
);
