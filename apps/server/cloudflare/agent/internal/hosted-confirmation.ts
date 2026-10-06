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

const lifetimeMs = 600_000;
const nonceBytes = 32;
const commandPrefix = "CONFIRMAR ";
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

/** Store a short-lived, single-use challenge before offering it through visible delivery. */
export const issueHostedConfirmation = ({
  db,
  userId,
  turnId,
  operation,
  input,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  operation: CatalogOperation;
  input: CanonicalToolEvidence;
  now: number;
}>): Effect.Effect<
  Option.Option<PendingHostedConfirmation>,
  Cause.UnknownError | Schema.SchemaError,
  Crypto.Crypto
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const nonce = yield* crypto.randomBytes(nonceBytes).pipe(Effect.option);
    if (Option.isNone(nonce)) return Option.none();
    const command = commandPrefix + Hex.encode(nonce.value);
    const inputJson = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
      input
    );
    const text = Schema.decodeOption(TranscriptText)(
      `Vas a ejecutar ${operation.id} con estos argumentos exactos: ${inputJson}.\n` +
        `Responde exactamente: ${command}`
    );
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
    return issued.meta.changes === 1 ? Option.some({ text: text.value, command }) : Option.none();
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
        sql: `EXISTS (SELECT 1 FROM hosted_whatsapp_inbound prior JOIN hosted_whatsapp_inbound active
        ON active.turn_id = ? AND active.user_id = prior.user_id WHERE prior.turn_id = issued_turn_id
        AND prior.portfolio_id = active.portfolio_id AND prior.bsuid = active.bsuid
        AND prior.business_phone_number_id = active.business_phone_number_id)`,
        params: [turnId],
      }
    : {
        sql: "NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id = issued_turn_id)",
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
