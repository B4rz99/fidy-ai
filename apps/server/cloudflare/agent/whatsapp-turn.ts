import { type Cause, Effect, Option, Schema } from "effect";
import { TranscriptText, UserId } from "@fidy/server/agent-runtime";
import {
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/reference";
import { WhatsAppInboundEvidence } from "./hosted-authority";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/model";

/** Private Core-to-User-coordinator text work. Never a public bearer or a Queue envelope. */
export const WhatsAppTurnAdmission = Schema.Struct({
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  ...WhatsAppInboundEvidence.fields,
  text: TranscriptText,
});
export type WhatsAppTurnAdmission = typeof WhatsAppTurnAdmission.Type;

/** Internal, authenticated Core-to-User-coordinator status projection; no text or bearer. */
export const WhatsAppStatusAdmission = Schema.Struct({
  userId: UserId,
  correlationToken: HostedDeliveryCorrelationToken,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  providerMessageId: WhatsAppProviderMessageId,
  outcome: Schema.Literals(["sent", "delivered", "failed"]),
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
});
export type WhatsAppStatusAdmission = typeof WhatsAppStatusAdmission.Type;

const UserRow = Schema.Struct({ user_id: UserId });
/** Correlation is a lookup hint only; the User coordinator rechecks the exact persisted attempt. */
export const findWhatsAppDeliveryUser = ({
  db,
  correlationToken,
  businessPhoneNumberId,
}: Readonly<{
  db: D1Database;
  correlationToken: HostedDeliveryCorrelationToken;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
}>): Effect.Effect<Option.Option<UserId>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT user_id FROM hosted_whatsapp_delivery
        WHERE correlation_token = ? AND business_phone_number_id = ?`)
        .bind(correlationToken, businessPhoneNumberId)
        .first()
    );
    return Option.map(Schema.decodeUnknownOption(UserRow)(row), ({ user_id }) => user_id);
  });
const ReplayRow = Schema.Struct({
  user_id: UserId,
  bsuid: WhatsAppBusinessScopedUserId,
  text: TranscriptText,
});

/** A signed replay has no new work. A changed body or identity is a conflict, never fresh admission. */
export const findWhatsAppReplay = ({
  db,
  userId,
  portfolioId,
  bsuid,
  messageId,
  text,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
  messageId: WhatsAppProviderMessageId;
  text: TranscriptText;
}>): Effect.Effect<"fresh" | "replay" | "conflict", Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT i.user_id, i.bsuid, e.text FROM hosted_whatsapp_inbound AS i
        JOIN transcript_entries AS e ON e.turn_id = i.turn_id AND e.user_id = i.user_id
          AND e.kind = 'user'
        WHERE i.portfolio_id = ? AND i.message_id = ?`)
        .bind(portfolioId, messageId)
        .first()
    );
    if (row === null) return "fresh";
    const prior = yield* Schema.decodeUnknownEffect(ReplayRow)(row);
    return prior.user_id === userId && prior.bsuid === bsuid && prior.text === text
      ? "replay"
      : "conflict";
  });
/** Pre-coordination lookup, not authorization: the coordinator must recheck the association. */
export const findWhatsAppUser = ({
  db,
  portfolioId,
  bsuid,
}: Readonly<{
  db: D1Database;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>): Effect.Effect<Option.Option<UserId>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT user_id FROM whatsapp_identities WHERE portfolio_id = ? AND bsuid = ?")
        .bind(portfolioId, bsuid)
        .first()
    );
    return Option.map(Schema.decodeUnknownOption(UserRow)(row), ({ user_id }) => user_id);
  });
