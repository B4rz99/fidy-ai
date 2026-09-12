import assert from "node:assert/strict";
import { UnknownJsonString } from "~/schema-compatibility";
import { expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Schema } from "effect";
import {
  InvalidKapsoSignature,
  decodeKapsoDisclosureLifecycleWebhook,
  maxKapsoWebhookBytes,
} from "./kapso-webhook";

const secret = "test-webhook-secret-32-characters";
const correlationToken = "11111111-1111-4111-8111-111111111111";
const providerMessageId = "wamid.lifecycle-test";
const receivedAt = DateTime.makeUnsafe("2026-04-03T12:10:00.000Z");

const encodedBody = (statuses: ReadonlyArray<unknown>, messageId = providerMessageId): Uint8Array =>
  new TextEncoder().encode(
    Schema.encodeSync(UnknownJsonString)({
      message: { id: messageId, kapso: { statuses } },
      phone_number_id: "123456789",
    })
  );

const status = (
  providerStatus: "delivered" | "failed" | "sent",
  timestamp: string,
  errors?: ReadonlyArray<{ readonly code: number }>
): Readonly<Record<string, unknown>> => ({
  id: providerMessageId,
  status: providerStatus,
  timestamp,
  biz_opaque_callback_data: correlationToken,
  ...(errors === undefined ? {} : { errors }),
});

type DecodeOverride =
  | Readonly<{ readonly _tag: "None" }>
  | Readonly<{ readonly _tag: "Body"; readonly value: Uint8Array }>
  | Readonly<{ readonly _tag: "MessageId"; readonly value: string }>
  | Readonly<{ readonly _tag: "Secret"; readonly value: string }>
  | Readonly<{ readonly _tag: "Signature"; readonly value: string }>;

const decode = (
  eventName: string,
  statuses: ReadonlyArray<unknown>,
  override: DecodeOverride = { _tag: "None" }
): ReturnType<typeof decodeKapsoDisclosureLifecycleWebhook> => {
  const webhookSecret = override._tag === "Secret" ? override.value : secret;
  const messageId = override._tag === "MessageId" ? override.value : undefined;
  const body = override._tag === "Body" ? override.value : encodedBody(statuses, messageId);
  const signature =
    override._tag === "Signature"
      ? override.value
      : new Bun.CryptoHasher("sha256", webhookSecret).update(body).digest("hex");
  return decodeKapsoDisclosureLifecycleWebhook({
    rawBody: body,
    secret: webhookSecret,
    signature,
    eventName,
    receivedAt,
  });
};

it.effect("selects the latest chronological lifecycle status rather than array position", () =>
  Effect.gen(function* () {
    const evidence = yield* decode("whatsapp.message.delivered", [
      status("delivered", "1775217960"),
      status("sent", "1775217900"),
    ]);

    expect(evidence.outcome).toBe("accepted");
    expect(evidence.correlationToken).toBe(correlationToken);
    expect(evidence.messageEvidence.providerMessageId).toBe(providerMessageId);

    expect(
      (yield* decode("whatsapp.message.delivered", [
        status("sent", "1775217900"),
        status("delivered", "1775217960"),
      ])).outcome
    ).toBe("accepted");
  })
);

it.effect("projects sent and allowlisted or terminal failed lifecycle evidence", () =>
  Effect.gen(function* () {
    const cases = [
      {
        eventName: "whatsapp.message.sent",
        providerStatus: status("sent", "1775217900"),
        expected: { outcome: "sent" },
      },
      {
        eventName: "whatsapp.message.failed",
        providerStatus: status("failed", "1775217900", [{ code: 130_429 }]),
        expected: { outcome: "failed", reason: "rate_limited", automaticRetry: true },
      },
      {
        eventName: "whatsapp.message.failed",
        providerStatus: status("failed", "1775217900", [{ code: 131_000 }]),
        expected: { outcome: "failed", reason: "provider_unavailable", automaticRetry: true },
      },
      {
        eventName: "whatsapp.message.failed",
        providerStatus: status("failed", "1775217900", [{ code: 131_016 }]),
        expected: { outcome: "failed", reason: "provider_unavailable", automaticRetry: true },
      },
      {
        eventName: "whatsapp.message.failed",
        providerStatus: status("failed", "1775217900", [{ code: 999_999 }]),
        expected: { outcome: "failed", reason: "invalid_response", automaticRetry: false },
      },
      {
        eventName: "whatsapp.message.failed",
        providerStatus: status("failed", "1775217900"),
        expected: { outcome: "failed", reason: "invalid_response", automaticRetry: false },
      },
    ] as const;

    for (const testCase of cases) {
      expect(yield* decode(testCase.eventName, [testCase.providerStatus])).toMatchObject(
        testCase.expected
      );
    }
  })
);

it.effect("rejects lifecycle proof that does not identify one valid latest event", () =>
  Effect.gen(function* () {
    const invalid = [
      decode("whatsapp.message.delivered", []),
      decode("whatsapp.message.delivered", [status("sent", "1775217900")]),
      decode("whatsapp.message.delivered", [status("delivered", "1775217900")], {
        _tag: "MessageId",
        value: "wamid.different-envelope",
      }),
      decode("whatsapp.message.delivered", [status("delivered", "1775217900")], {
        _tag: "Signature",
        value: "0".repeat(64),
      }),
      decode("whatsapp.message.delivered", [status("delivered", "1775217900")], {
        _tag: "Secret",
        value: "short",
      }),
      decode("unsupported.event", [status("delivered", "1775217900")]),
      decode("whatsapp.message.delivered", [status("delivered", "9999999999999999")]),
      decode("whatsapp.message.delivered", [status("delivered", "8640000000001")]),
      decode("whatsapp.message.delivered", [status("delivered", "1775217900")], {
        _tag: "Signature",
        value: "not-hexadecimal",
      }),
      decode("whatsapp.message.delivered", [], {
        _tag: "Body",
        value: new TextEncoder().encode("not-json"),
      }),
      decode("whatsapp.message.delivered", [
        status(
          "delivered",
          String(
            Math.floor(DateTime.toEpochMillis(DateTime.add(receivedAt, { minutes: 10 })) / 1_000)
          )
        ),
      ]),
    ];

    for (const effect of invalid) expect((yield* Effect.flip(effect))._tag).toBeDefined();
  })
);

it.effect("rejects oversized lifecycle bytes before decoding", () =>
  Effect.gen(function* () {
    const body = new Uint8Array(maxKapsoWebhookBytes + 1);
    const failure = yield* decode("whatsapp.message.delivered", [], {
      _tag: "Body",
      value: body,
    }).pipe(Effect.flip);
    expect(failure._tag).toBe("KapsoPayloadTooLarge");
  })
);

// OpenSSL dgst -sha256 -mac HMAC -macopt key:test-webhook-secret-32-characters of the exact bytes.
const vectorBody = new TextEncoder().encode(
  '{"message":{"id":"wamid.lifecycle-test","kapso":{"statuses":[{"id":"wamid.lifecycle-test","status":"delivered","timestamp":"1775217900","biz_opaque_callback_data":"11111111-1111-4111-8111-111111111111"}]}},"phone_number_id":"123456789"}'
);
const vectorSignature = "5b1babb145b0a2550a9788dceaf627582c55be37590c7f3c8e38e421339ded42";

const decodeVector = (
  signature: string,
  rawBody: Uint8Array = vectorBody
): ReturnType<typeof decodeKapsoDisclosureLifecycleWebhook> =>
  decodeKapsoDisclosureLifecycleWebhook({
    rawBody,
    secret,
    signature,
    eventName: "whatsapp.message.delivered",
    receivedAt,
  });

it.effect("authenticates a known HMAC-SHA256 vector and rejects malformed signatures", () =>
  Effect.gen(function* () {
    expect(yield* decodeVector(vectorSignature)).toMatchObject({
      outcome: "accepted",
      correlationToken,
    });
    expect((yield* decodeVector(vectorSignature.toUpperCase())).outcome).toBe("accepted");

    const altered = `${vectorSignature.slice(0, -1)}${vectorSignature.endsWith("2") ? "3" : "2"}`;
    const malformed = [
      altered,
      vectorSignature.slice(0, -1),
      `${vectorSignature}00`,
      "z".repeat(64),
      "a".repeat(63),
      "",
    ];
    for (const signature of malformed) {
      assert.deepStrictEqual(
        Exit.match(yield* decodeVector(signature).pipe(Effect.exit), {
          onFailure: (cause) => Exit.fail(Cause.squash(cause)),
          onSuccess: Exit.succeed,
        }),
        Exit.fail(new InvalidKapsoSignature())
      );
    }
    assert.deepStrictEqual(
      Exit.match(
        yield* decodeVector("not-hexadecimal", new TextEncoder().encode("not-json")).pipe(
          Effect.exit
        ),
        {
          onFailure: (cause) => Exit.fail(Cause.squash(cause)),
          onSuccess: Exit.succeed,
        }
      ),
      Exit.fail(new InvalidKapsoSignature())
    );
  })
);
