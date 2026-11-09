import { UserId } from "../../../src/core/identity/contract";
import { type ConfirmationRead, describeConfirmation } from "./confirmation-description";
import { type Cause, Effect, Option, Schema } from "effect";
import { TranscriptText, type TranscriptTurnId } from "../../../src/core/agent/contract";
import type { CanonicalToolEvidence } from "../../../src/core/agent/contract";
import { HostedTurnConfirmation } from "../../../src/shell/agent/contract";

const maximumReplyButtonBodyLength = 1024;

/** Only the host formats this review, from validated input and the owner's observed revision. */
export const hostedChallengeText = ({
  db,
  userId,
  operation,
  input,
  read,
  timeZone,
  command,
  nativeButton,
}: Readonly<{
  db: D1Database;
  userId: string;
  operation: string;
  input: CanonicalToolEvidence;
  read: ConfirmationRead;
  timeZone: string;
  command: string;
  nativeButton: boolean;
}>): Effect.Effect<Option.Option<TranscriptText>> =>
  Effect.gen(function* () {
    const description = yield* describeConfirmation({
      context: { read, timeZone, db, userId: UserId.make(userId) },
      operation,
      input,
    });
    return Option.flatMap(description, (text) => {
      const visible = nativeButton
        ? `${text}\nToca Confirmar para aplicar estos cambios.`
        : `${text}\nResponde exactamente: ${command}`;
      return nativeButton && visible.length > maximumReplyButtonBodyLength
        ? Option.none()
        : Schema.decodeOption(TranscriptText)(visible);
    });
  });

const Row = Schema.Struct({
  command: HostedTurnConfirmation.fields.command,
});
/** Metadata comes from a live host-issued challenge, never a model-written command in reply text. */
export const readBrowserConfirmation = ({
  db,
  userId,
  turnId,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  turnId: TranscriptTurnId;
  now: number;
}>): Effect.Effect<
  Option.Option<typeof HostedTurnConfirmation.Type>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT command
      FROM hosted_confirmations c WHERE user_id=? AND issued_turn_id=?
      AND consumed_turn_id IS NULL AND expires_at_ms>?
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE turn_id=c.issued_turn_id)
      ORDER BY issued_at_ms DESC, rowid DESC LIMIT 1`)
        .bind(userId, turnId, now)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Row)(raw);
    return Option.some({ command: row.command });
  });

/** Stage exactly the readable text the browser displays; the opaque command travels separately. */
export const browserConfirmationText = ({
  text,
  command,
}: Readonly<{ text: TranscriptText; command: string }>): Option.Option<TranscriptText> => {
  const suffix = `\nResponde exactamente: ${command}`;
  return text.endsWith(suffix)
    ? Schema.decodeOption(TranscriptText)(text.slice(0, -suffix.length))
    : Option.none();
};
