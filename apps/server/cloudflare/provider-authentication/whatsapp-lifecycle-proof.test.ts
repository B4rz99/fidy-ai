import { whatsappMessages } from "./whatsapp-messages.test-fixture";
import { Clock, Effect, Option } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { disposeJourneys, setupWhatsApp } from "./journey.test-fixture";

afterAll(disposeJourneys);
afterEach(() => vi.restoreAllMocks());

const uncorrelatedStatuses = (fault: string, now: number): ReadonlyArray<unknown> => [
  {
    id: fault === "status_message" ? "wamid.other" : "wamid.review",
    status: fault === "read_only" ? "read" : "delivered",
    timestamp: String(Math.floor((fault === "future" ? now + 600_000 : now) / 1000)),
    ...(fault === "malformed" ? { biz_opaque_callback_data: "invalid" } : {}),
  },
  ...(fault === "mixed"
    ? [
        {
          id: "wamid.review",
          status: "sent",
          timestamp: String(Math.floor(now / 1000)),
          biz_opaque_callback_data: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ]
    : []),
  ...(fault === "inline_read"
    ? [{ id: "wamid.review", status: "read", timestamp: String(Math.floor(now / 1000) + 1) }]
    : []),
];

it.each([
  "inline",
  "inline_read",
  "bad_signature",
  "message",
  "endpoint",
  "status_message",
  "mixed",
  "malformed",
  "future",
  "read_only",
] as const)("validates uncorrelated lifecycle proof before acknowledging it: %s", (fault) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const now = yield* Clock.currentTimeMillis;
      const statuses = uncorrelatedStatuses(fault, now);
      const inline = fault.startsWith("inline");
      let reads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        reads += 1;
        return Promise.resolve(
          Response.json({
            id: fault === "message" ? "wamid.other" : "wamid.review",
            kapso: {
              direction: "outbound",
              phone_number_id: fault === "endpoint" ? "987654321098765" : "123456789012345",
              statuses,
            },
          })
        );
      });
      const response = yield* whatsappMessages.sendPacket(
        journey,
        {
          phone_number_id: "123456789012345",
          message: {
            id: "wamid.review",
            kapso: {
              direction: "outbound",
              status: "delivered",
              ...(inline ? { statuses } : {}),
            },
          },
        },
        {
          signature: fault === "bad_signature" ? Option.some("0".repeat(64)) : Option.none(),
          event: "whatsapp.message.delivered",
        }
      );
      expect(response.status).toBe(inline ? 200 : 401);
      expect(reads).toBe(inline || fault === "bad_signature" ? 0 : 1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT count(*) AS total FROM pending_consent_delivery")
            .first<{ total: number }>()
        ))?.total
      ).toBe(0);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT count(*) AS total FROM whatsapp_provider_handoffs")
            .first<{ total: number }>()
        ))?.total
      ).toBe(0);
    })
  )
);
