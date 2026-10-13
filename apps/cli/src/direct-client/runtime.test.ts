import { expect, it } from "@effect/vitest";
import { PATRecipientLabel } from "@fidy/server/client";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makePairingClient } from "./runtime";

const clientFor = (body: string, status = 200): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": "application/json" } })
      )
    )
  );

it.effect(
  "derives declared pairing errors and distinguishes source refusal from polling slowdown",
  () =>
    Effect.gen(function* () {
      const invalid = yield* makePairingClient(
        clientFor(
          '{"error":{"code":"pairing_invalid","message":"This PAT pairing is no longer valid. Start a new request."}}',
          400
        )
      );
      const result = yield* Effect.result(
        invalid.start({
          recipientLabel: PATRecipientLabel.make("Mi agente"),
          scopes: ["read"],
          lifetimeDays: 7,
        })
      );
      expect(result).toMatchObject({ failure: { reason: "PairingInvalid" } });
    })
);
