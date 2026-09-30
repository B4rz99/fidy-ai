import {
  CanonicalToolEvidence,
  TranscriptText,
  type TranscriptTurnId,
  type UserId,
} from "@fidy/server/agent-runtime";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import { type Cause, Effect, Option, Schema } from "effect";
import type { CatalogOperation } from "../../src/shell/_shared/operation-catalog";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import { newId } from "../platform/operations";

const lifetimeMs = 600_000;
const nonceBytes = 32;
const hexRadix = 16;
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

const randomCommand = (): string =>
  commandPrefix +
  Array.from(crypto.getRandomValues(new Uint8Array(nonceBytes)), (byte) =>
    byte.toString(hexRadix).padStart(2, "0")
  ).join("");

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
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const command = randomCommand();
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
}: Readonly<{
  db: D1Database;
  userId: UserId;
  command: TranscriptText;
  now: number;
}>): Effect.Effect<Option.Option<ConfirmationRow>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (!isHostedConfirmationAttempt(command)) return Option.none();
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT c.id, c.operation, c.input_json, c.command
    FROM hosted_confirmations AS c JOIN hosted_turns AS t ON t.id = c.issued_turn_id
    WHERE c.user_id = ? AND c.consumed_turn_id IS NULL AND c.expires_at_ms > ?
      AND t.status = 'completed'
    ORDER BY c.issued_at_ms DESC, c.rowid DESC LIMIT 1`)
        .bind(userId, now)
        .first()
    );
    return Option.flatMap(
      Option.fromNullishOr(row),
      Schema.decodeUnknownOption(ConfirmationRow)
    ).pipe(Option.filter((candidate) => candidate.command === command));
  });

/** Consume exactly one approved challenge only while the new Turn and live WebSession match. */
export const consumeHostedConfirmation = ({
  db,
  subject,
  turnId,
  challenge,
  now,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
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
    const authority = liveWebSessionAuthority({ subject, current: now });
    const updated = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_confirmations SET consumed_turn_id = ?, consumed_at_ms = ?
    WHERE id = ? AND user_id = ? AND command = ? AND consumed_turn_id IS NULL
      AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM hosted_turns AS prior
        WHERE prior.id = issued_turn_id AND prior.user_id = ? AND prior.status = 'completed')
      AND EXISTS (SELECT 1 FROM hosted_turns AS active
        WHERE active.id = ? AND active.user_id = ? AND active.status = 'pending')
      AND EXISTS (SELECT 1 FROM web_sessions WHERE ${authority.predicate})`)
        .bind(
          turnId,
          now,
          challenge.id,
          subject.userId,
          challenge.command,
          now,
          subject.userId,
          turnId,
          subject.userId,
          ...authority.bindings
        )
        .run()
    );
    return updated.meta.changes === 1
      ? Option.some({ operation: challenge.operation, input: decoded.value })
      : Option.none();
  });
