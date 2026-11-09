import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Redacted } from "effect";
import { authenticateWhatsAppInbound } from "./operations";

const secret = "kapso-confirmation-test-secret-32-characters";
const command = `CONFIRMAR ${"a".repeat(64)}`;
const decode = (id: string, signature?: string): ReturnType<typeof authenticateWhatsAppInbound> => {
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      message: {
        id: "wamid.confirm-button-inbound",
        timestamp: "1775217600",
        type: "interactive",
        from_user_id: "CO.573001234567",
        context: { id: "wamid.confirm-button-outbound" },
        interactive: { type: "button_reply", button_reply: { id, title: "Confirmar" } },
      },
      conversation: { business_scoped_user_id: "CO.573001234567" },
      phone_number_id: "123456789012345",
      is_new_conversation: false,
    })
  );
  return authenticateWhatsAppInbound({
    rawBody,
    secret: Redacted.make(secret),
    signature: signature ?? new Bun.CryptoHasher("sha256", secret).update(rawBody).digest("hex"),
    deliveryKey: "confirmation-delivery-001",
    businessPortfolioId: "123456789",
    receivedAt: DateTime.makeUnsafe("2026-04-03T12:10:00Z"),
  });
};
it.effect(
  "projects a signed button's exact command and original chat, never its visible title as approval",
  () =>
    Effect.gen(function* () {
      const receipt = yield* decode(command);
      expect(receipt.events[0].content).toEqual({ _tag: "Text", text: command });
      expect(receipt.events[0].caller.businessScopedUserId).toBe("CO.573001234567");
      expect(receipt.events[0].replyToMessageId).toEqual(
        Option.some("wamid.confirm-button-outbound")
      );
      for (const invalid of ["Confirmar", "CONFIRMAR invented", `CONFIRMAR ${"a".repeat(63)}`]) {
        expect(Exit.isFailure(yield* decode(invalid).pipe(Effect.exit))).toBe(true);
      }
      expect(Exit.isFailure(yield* decode(command, "00".repeat(32)).pipe(Effect.exit))).toBe(true);
    })
);
