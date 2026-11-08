import { Effect, Option, Schema } from "effect";
import { whatsAppIdentityQuery } from "../../identity/operations";
import { type WhatsAppTurnAdmission, WhatsAppUnavailable } from "../contract";

const roles = {
  "budget-offer": "budget-threshold",
  "reminder-offer": "manual-entry-reminder",
  "recurring-offer": "new-recurring-series",
} as const;
const DeliveredChoice = Schema.Struct({
  delivery_id: Schema.String.check(Schema.isUUID()),
  role: Schema.Literals(["budget-offer", "reminder-offer", "recurring-offer", "reminder-question"]),
});
const choiceDecision = (text: string): Option.Option<"accept" | "decline" | "revoke"> => {
  const value = text
    .trim()
    .toLocaleLowerCase("es-CO")
    .replace(/[.!]+$/u, "");
  if (["sí", "si"].includes(value)) return Option.some("accept");
  if (["no", "no, gracias", "no gracias"].includes(value)) return Option.some("decline");
  return value === "desactivar" ? Option.some("revoke") : Option.none();
};
/** Resolve literal replies against this caller's delivered message. The decision owner still checks
 * the exact disclosure, current grant, expiry and one-use evidence before any state changes. */
export const readProactivityReplyChoice = ({
  db,
  proof,
  now,
}: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission; now: number }>): Effect.Effect<
  Option.Option<string>,
  WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const decision = choiceDecision(proof.text);
    if (Option.isNone(decision) || Option.isNone(proof.replyToMessageId)) return Option.none();
    const replyToMessageId = proof.replyToMessageId.value;
    const association = whatsAppIdentityQuery({
      userId: proof.userId,
      portfolioId: proof.portfolioId,
      bsuid: proof.bsuid,
    });
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT delivery_id,role FROM whatsapp_deliveries WHERE kind='proactivity' AND user_id=? AND portfolio_id=? AND bsuid=? AND business_phone_number_id=? AND provider_message_id=? AND state='delivered' AND delivered_at_ms<=?+1000 AND text IS NOT NULL AND (?<>'accept' OR expires_at_ms>?) AND role IN ('budget-offer','reminder-offer','recurring-offer','reminder-question') AND EXISTS (${association.sql})`
        )
        .bind(
          proof.userId,
          proof.portfolioId,
          proof.bsuid,
          proof.businessPhoneNumberId,
          replyToMessageId,
          proof.occurredAtMs,
          decision.value,
          now,
          ...association.params
        )
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(DeliveredChoice)(raw);
    if (row.role === "reminder-question") {
      return Option.some(
        `reminder:${row.delivery_id}:${decision.value === "accept" ? "continue" : "stop"}`
      );
    }
    return Option.some(`p:${roles[row.role]}:${row.delivery_id}:${decision.value}`);
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
