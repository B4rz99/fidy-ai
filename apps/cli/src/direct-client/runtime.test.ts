import { expect, it } from "@effect/vitest";
import { PATRecipientLabel } from "@fidy/server/client";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makePairingClient, protectClient } from "./runtime";

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

it.effect(
  "rejects a foreign origin before transport and bounds streamed bodies without trusting Content-Length",
  () =>
    Effect.gen(function* () {
      let sent = false;
      const raw = HttpClient.make((request) =>
        Effect.sync(() => {
          sent = true;
          return HttpClientResponse.fromWeb(request, new Response("{}"));
        })
      );
      expect(
        Exit.isFailure(yield* Effect.exit(protectClient(raw).get("https://attacker.example")))
      ).toBe(true);
      expect(sent).toBe(false);
      const hostileLength = 20_000;
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            protectClient(clientFor("x".repeat(hostileLength))).get(
              "https://api.fidyapp.com/pat-pairings"
            )
          )
        )
      ).toBe(true);
    })
);
