import { reviewCancellation } from "./cancellation-review";
import { HostedTurnConfirmation } from "../../../src/shell/agent/contract";
import type { ConfirmationRead } from "./confirmation-description";
import {
  CanonicalToolEvidence,
  TranscriptText,
  type TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { type HostedSubject, hostedAuthority, isWhatsAppHosted } from "./hosted-authority";
import { type Cause, Crypto, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { newId } from "../../secret-material/operations";

import { hostedChallengeText } from "./hosted-browser-confirmation";

const lifetimeMs = 600_000;
const nonceBytes = 32;
const commandPrefix = "CONFIRMAR ";
const modelCommand = new RegExp(`\\b${commandPrefix}[a-f0-9]{${nonceBytes * 2}}\\b`, "iu");

/** Executable confirmation commands are host presentation, never model-generated prose. */
export const guardModelConfirmationReply = (text: TranscriptText): TranscriptText =>
  modelCommand.test(text)
    ? TranscriptText.make(
        "No pude preparar esos cambios. Vuelve a pedirlos para revisarlos antes de confirmar."
      )
    : text;

/** Identify only exact confirmation attempts, so malformed commands cannot become model prompts. */
export const isHostedConfirmationAttempt = (text: TranscriptText): boolean =>
  text.startsWith(commandPrefix);
const ConfirmationRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  operation: Schema.String,
  input_json: Schema.String,
  command: Schema.String,
});
export type ConfirmationRow = typeof ConfirmationRow.Type;

/** A User-visible host challenge, bound to precisely the model's validated canonical input. */
export type PendingHostedConfirmation = Readonly<{ text: TranscriptText; command: string }>;
type ConfirmationPreparation =
  | Readonly<PendingHostedConfirmation & { _tag: "Challenge" }>
  | Readonly<{ _tag: "Notice"; text: TranscriptText }>;

/** Store a short-lived, single-use challenge before offering it through visible delivery. */
type IssueConfirmationInput = Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  operation: CatalogOperation;
  input: CanonicalToolEvidence;
  now: number;
  read: ConfirmationRead;
  timeZone: string;
  nativeButton: boolean;
}>;
export const issueHostedConfirmation = ({
  db,
  userId,
  turnId,
  operation,
  input,
  now,
  read,
  timeZone,
  nativeButton,
}: IssueConfirmationInput): Effect.Effect<
  Option.Option<ConfirmationPreparation>,
  Cause.UnknownError | Schema.SchemaError,
  Crypto.Crypto
> =>
  Effect.gen(function* () {
    const cancellation = yield* reviewCancellation({ operation: operation.id, input, read });
    if (cancellation._tag === "Notice") return Option.some(cancellation);
    const crypto = yield* Crypto.Crypto;
    const nonce = yield* crypto.randomBytes(nonceBytes).pipe(Effect.option);
    if (Option.isNone(nonce)) return Option.none();
    const command = commandPrefix + Hex.encode(nonce.value);
    const inputJson = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
      input
    );
    const text = yield* hostedChallengeText({
      db,
      userId,
      operation: operation.id,
      input,
      read,
      timeZone,
      nativeButton,
      command,
    });
    if (Option.isNone(text)) return Option.none();
    const issued = yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO hosted_confirmations
    (id, user_id, issued_turn_id, operation, input_json, command, issued_at_ms, expires_at_ms)
    SELECT ?, ?, id, ?, ?, ?, ?, ? FROM hosted_turns
    WHERE id = ? AND user_id = ? AND status = 'pending'`)
        .bind(
          newId(),
          userId,
          operation.id,
          inputJson,
          command,
          now,
          now + lifetimeMs,
          turnId,
          userId
        )
        .run()
    );
    return issued.meta.changes === 1
      ? Option.some({ _tag: "Challenge", text: text.value, command })
      : Option.none();
  });

export const readWhatsAppConfirmation = ({
  db,
  userId,
  turnId,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  now: number;
}>): Effect.Effect<Option.Option<typeof HostedTurnConfirmation.Type>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT command FROM hosted_confirmations c WHERE user_id=? AND issued_turn_id=? AND consumed_turn_id IS NULL AND expires_at_ms>? AND EXISTS(SELECT 1 FROM hosted_turns t WHERE t.id=c.issued_turn_id AND t.user_id=c.user_id AND t.inbound_message_id IS NOT NULL AND t.status='pending') LIMIT 1`
        )
        .bind(userId, turnId, now)
        .first()
    );
    return Option.flatMap(
      Option.fromNullishOr(row),
      Schema.decodeUnknownOption(HostedTurnConfirmation)
    );
  });

/** Read only the most recent challenge for this stable User after its visible Turn completed. */
export const findHostedConfirmation = ({
  db,
  userId,
  command,
  now,
  recoveringTurn,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  command: TranscriptText;
  now: number;
  recoveringTurn: Option.Option<TranscriptTurnId>;
}>): Effect.Effect<Option.Option<ConfirmationRow>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (!isHostedConfirmationAttempt(command)) return Option.none();
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT c.id, c.operation, c.input_json, c.command
    FROM hosted_confirmations AS c JOIN hosted_turns AS t ON t.id = c.issued_turn_id
    WHERE c.user_id = ? AND ((c.consumed_turn_id IS NULL AND c.expires_at_ms > ?)
      OR (c.consumed_turn_id = ? AND c.consumed_at_ms < c.expires_at_ms))
      AND t.status = 'completed'
    ORDER BY c.issued_at_ms DESC, c.rowid DESC LIMIT 1`)
        .bind(userId, now, Option.getOrNull(recoveringTurn))
        .first()
    );
    return Option.flatMap(
      Option.fromNullishOr(row),
      Schema.decodeUnknownOption(ConfirmationRow)
    ).pipe(Option.filter((candidate) => candidate.command === command));
  });

const confirmationChannel = ({
  subject,
  turnId,
}: Readonly<{ subject: HostedSubject; turnId: TranscriptTurnId }>): OwnedStatement =>
  isWhatsAppHosted(subject)
    ? {
        sql: `EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) prior JOIN (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) active
        ON active.turn_id = ? AND active.user_id = prior.user_id WHERE prior.turn_id = issued_turn_id
        AND prior.portfolio_id = active.portfolio_id AND prior.bsuid = active.bsuid
        AND prior.business_phone_number_id = active.business_phone_number_id)`,
        params: [turnId],
      }
    : {
        sql: "NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE turn_id = issued_turn_id)",
        params: [],
      };

const confirmationTurnGuard = ({
  subject,
  turnId,
  now,
}: Readonly<{ subject: HostedSubject; turnId: TranscriptTurnId; now: number }>): OwnedStatement => {
  const authority = hostedAuthority({ subject, current: now });
  const channel = confirmationChannel({ subject, turnId });
  return {
    sql: `EXISTS (SELECT 1 FROM hosted_turns AS prior
    WHERE prior.id = issued_turn_id AND prior.user_id = ? AND prior.status = 'completed'
      AND prior.hosted_session_id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?))
    AND EXISTS (SELECT 1 FROM hosted_turns AS active WHERE active.id = ? AND active.user_id = ? AND active.status = 'pending')
    AND (${channel.sql}) AND EXISTS (${authority.sql})`,
    params: [
      subject.userId,
      turnId,
      subject.userId,
      turnId,
      subject.userId,
      ...channel.params,
      ...authority.params,
    ],
  };
};

/** Consume once, or recover consumption by this exact live Pending Turn in the same channel.
 * Recovery rechecks authority without rewriting or lending another Turn's consumed challenge.
 */
export const consumeHostedConfirmation = ({
  db,
  subject,
  turnId,
  challenge,
  now,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  turnId: TranscriptTurnId;
  challenge: ConfirmationRow;
  now: number;
}>): Effect.Effect<
  Option.Option<Readonly<{ operation: string; input: CanonicalToolEvidence }>>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const decoded = Schema.decodeOption(Schema.fromJsonString(CanonicalToolEvidence))(
      challenge.input_json
    );
    if (Option.isNone(decoded)) return Option.none();
    const guard = confirmationTurnGuard({ subject, turnId, now });
    const updated = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_confirmations SET consumed_turn_id = ?, consumed_at_ms = ?
    WHERE id = ? AND user_id = ? AND command = ? AND consumed_turn_id IS NULL
      AND expires_at_ms > ? AND (${guard.sql})`)
        .bind(turnId, now, challenge.id, subject.userId, challenge.command, now, ...guard.params)
        .run()
    );
    const consumed =
      updated.meta.changes === 1 ||
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            `SELECT 1 FROM hosted_confirmations WHERE id=? AND user_id=? AND command=? AND operation=? AND input_json=? AND consumed_turn_id=? AND consumed_at_ms < expires_at_ms AND (${guard.sql})`
          )
          .bind(
            challenge.id,
            subject.userId,
            challenge.command,
            challenge.operation,
            challenge.input_json,
            turnId,
            ...guard.params
          )
          .first()
      )) !== null;
    return consumed
      ? Option.some({ operation: challenge.operation, input: decoded.value })
      : Option.none();
  });
