import { prepareWhatsAppIdentity } from "../identity/operations";
import { type Cause, Effect, Option, Schema } from "effect";
import {
  HostedAgentSessionId,
  TranscriptText,
  type TranscriptTurnId,
  UserId,
} from "@fidy/server/agent-runtime";
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

/** Well inside the 30-day Turn evidence retention, even after delayed delivery. */
export const hostedInboundReplayWindowMs = 604_800_000;
export const withinHostedInboundWindow = ({
  occurredAtMs,
  receivedAtMs,
}: Readonly<{ occurredAtMs: number; receivedAtMs: number }>): boolean =>
  occurredAtMs >= receivedAtMs - hostedInboundReplayWindowMs;

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
/** Window evidence never authorizes the User or the Turn; it only refuses late free-form sends. */
export const isWhatsAppWindowOpen = ({
  db,
  userId,
  turnId,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  now: number;
}>): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      prepareWhatsAppIdentity({
        db,
        userId,
        statement: {
          sql: `SELECT 1 AS open FROM hosted_whatsapp_inbound AS i
      JOIN hosted_whatsapp_windows AS w ON w.user_id = i.user_id
        AND w.portfolio_id = i.portfolio_id AND w.bsuid = i.bsuid
      JOIN identity_associations AS identity ON identity.userId = i.user_id
        AND identity.businessPortfolioId = i.portfolio_id AND identity.businessScopedUserId = i.bsuid
      WHERE i.turn_id = ? AND i.user_id = ? AND w.closes_at_ms > ?`,
          params: [turnId, userId, now],
        },
      }).first()
    );
    return row !== null;
  });

/** Bounded scheduled cleanup; no inbound webhook is needed to expire old windows. */
export const sweepExpiredWhatsAppWindows = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`DELETE FROM hosted_whatsapp_windows WHERE rowid IN (
    SELECT rowid FROM hosted_whatsapp_windows WHERE closes_at_ms <= ?
    ORDER BY closes_at_ms LIMIT 128)`)
      .bind(now)
      .run()
  ).pipe(Effect.asVoid);

const ReplayRow = Schema.Struct({
  user_id: UserId,
  bsuid: WhatsAppBusinessScopedUserId,
  text: Schema.NullOr(TranscriptText),
});

/** After Compaction removes exact text, the same identity/provider id still cannot start new work. */
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
        LEFT JOIN transcript_entries AS e ON e.turn_id = i.turn_id AND e.user_id = i.user_id
          AND e.kind = 'user'
        WHERE i.portfolio_id = ? AND i.message_id = ?`)
        .bind(portfolioId, messageId)
        .first()
    );
    if (row === null) return "fresh";
    const prior = yield* Schema.decodeUnknownEffect(ReplayRow)(row);
    if (prior.user_id !== userId || prior.bsuid !== bsuid) return "conflict";
    return prior.text === null || prior.text === text ? "replay" : "conflict";
  });

export const classifyWhatsAppAdmission = ({
  db,
  proof,
  now,
}: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission; now: number }>): Effect.Effect<
  "expired" | "fresh" | "replay" | "conflict",
  Cause.UnknownError | Schema.SchemaError
> =>
  withinHostedInboundWindow({ occurredAtMs: proof.occurredAtMs, receivedAtMs: now })
    ? findWhatsAppReplay({
        db,
        userId: proof.userId,
        portfolioId: proof.portfolioId,
        bsuid: proof.bsuid,
        messageId: proof.messageId,
        text: proof.text,
      })
    : Effect.succeed("expired");

const PendingWork = Schema.Struct({
  started_at_ms: Schema.Int,
  hosted_session_id: HostedAgentSessionId,
  portfolio_id: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  business_phone_number_id: WhatsAppBusinessPhoneNumberId,
  association_current: Schema.Literals([0, 1]),
  text: TranscriptText,
});
/** A continuation reads only its own pending Turn and exact User Transcript, never Queue text. */
export const readWhatsAppPendingWork = ({
  db,
  userId,
  turnId,
}: Readonly<{ db: D1Database; userId: UserId; turnId: TranscriptTurnId }>): Effect.Effect<
  Option.Option<typeof PendingWork.Type>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareWhatsAppIdentity({
        db,
        userId,
        statement: {
          sql: `SELECT
      t.started_at_ms, t.hosted_session_id, i.portfolio_id, i.bsuid,
      i.business_phone_number_id, e.text,
      EXISTS (SELECT 1 FROM identity_associations AS w
        WHERE w.userId = t.user_id AND w.businessPortfolioId = i.portfolio_id AND w.businessScopedUserId = i.bsuid)
        AS association_current
      FROM hosted_turns AS t JOIN hosted_whatsapp_inbound AS i ON i.turn_id = t.id
      JOIN hosted_whatsapp_outbox AS o ON o.turn_id = t.id AND o.user_id = t.user_id
      JOIN transcript_entries AS e ON e.turn_id = t.id AND e.user_id = t.user_id AND e.kind = 'user'
      WHERE t.id = ? AND t.user_id = ? AND t.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_delivery WHERE turn_id = t.id)`,
          params: [turnId, userId],
        },
      }).first()
    );
    return Schema.decodeUnknownOption(PendingWork)(raw);
  });
