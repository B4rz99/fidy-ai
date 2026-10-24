import { discloseLegacyChat, disposeLegacyConsent } from "./legacy-disclosure.test-fixture";
import { Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { disposeJourneys, setupWhatsApp } from "./journey.test-fixture";
import { whatsappMessages } from "./whatsapp-messages.test-fixture";

afterAll(() => Promise.all([disposeJourneys(), disposeLegacyConsent()]));
afterEach(() => vi.restoreAllMocks());

it.each([
  "pending_sent",
  "bad_signature",
  "wrong_message",
  "wrong_endpoint",
  "wrong_direction",
  "empty_history",
  "null_history",
  "delivered_hint",
  "failed_hint",
  "read_without_history",
] as const)("keeps pending sent history non-authoritative: %s", (fault) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const outbound: Array<string> = [];
      let reads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          reads += 1;
          return Promise.resolve(
            Response.json({
              id: fault === "wrong_message" ? "wamid.other" : "wamid.disclosure",
              kapso: {
                direction: fault === "wrong_direction" ? "inbound" : "outbound",
                phone_number_id: fault === "wrong_endpoint" ? "987654321098765" : "123456789012345",
                status: fault === "read_without_history" ? "read" : "sent",
                ...(fault === "empty_history" ? { statuses: [] } : {}),
                ...(fault === "null_history" ? { statuses: null } : {}),
              },
            })
          );
        }
        return request.text().then((body) => {
          outbound.push(body);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: `wamid.${outbound.length === 1 ? "disclosure" : "handoff"}` }],
          });
        });
      });
      expect((yield* discloseLegacyChat(journey, "Hola")).status).toBe(200);
      let status: "sent" | "delivered" | "failed" = "sent";
      if (fault === "delivered_hint") status = "delivered";
      if (fault === "failed_hint") status = "failed";
      const response = yield* whatsappMessages.sendPacket(
        journey,
        {
          phone_number_id: "123456789012345",
          message: { id: "wamid.disclosure", kapso: { direction: "outbound", status } },
        },
        {
          event: `whatsapp.message.${status}`,
          signature: fault === "bad_signature" ? Option.some("0".repeat(64)) : Option.none(),
        }
      );
      expect(response.status).toBe(fault === "pending_sent" ? 200 : 401);
      expect(reads).toBe(fault === "bad_signature" ? 0 : 1);
      expect((yield* whatsappMessages.sendChat(journey, "Acepto")).status).toBe(409);
      expect(outbound).toHaveLength(1);
      if (fault !== "pending_sent") return;
      const correlation = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ biz_opaque_callback_data: Schema.String }))
      )(outbound[0] ?? "");
      const now = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendPacket(
          journey,
          {
            phone_number_id: "123456789012345",
            message: {
              id: "wamid.disclosure",
              kapso: {
                statuses: [
                  {
                    id: "wamid.disclosure",
                    status: "delivered",
                    timestamp: String(Math.floor(now / 1000)),
                    biz_opaque_callback_data: correlation.biz_opaque_callback_data,
                  },
                ],
              },
            },
          },
          { event: "whatsapp.message.delivered", signature: Option.none() }
        )).status
      ).toBe(200);
      yield* whatsappMessages.advanceClock(301_100);
      const acceptedAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          timestamp: Math.floor(acceptedAt / 1000) + 1,
        })).status
      ).toBe(200);
      expect(outbound).toHaveLength(2);
      expect(outbound[1]).toContain("/login?handoff=");
    })
  )
);
