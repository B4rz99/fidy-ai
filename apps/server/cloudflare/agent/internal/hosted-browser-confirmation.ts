import { type Cause, Effect, Option, Schema } from "effect";
import { TranscriptText, type TranscriptTurnId } from "../../../src/core/agent/contract";
import type { CanonicalToolEvidence } from "../../../src/core/agent/contract";
import { HostedTurnConfirmation } from "../../../src/shell/agent/contract";
import { ApplyRecurringCanonicalInput } from "../../../src/shell/recurring-plans/contract";
import { describeRecurringLifecycle } from "../../recurring-plans/operations";

const operationId = "recurringPlans.applyRecurringEdit";
const Input = Schema.toCodecJson(ApplyRecurringCanonicalInput);

/** Only the host formats this review, from validated input and the owner's observed revision. */
export const hostedChallengeText = ({
  db,
  userId,
  operation,
  input,
  inputJson,
  command,
}: Readonly<{
  db: D1Database;
  userId: string;
  operation: string;
  input: CanonicalToolEvidence;
  inputJson: string;
  command: string;
}>): Effect.Effect<Option.Option<TranscriptText>> =>
  Effect.gen(function* () {
    const recurring = operation === operationId ? Schema.decodeOption(Input)(input) : Option.none();
    let description = `Vas a ejecutar ${operation} con estos argumentos exactos: ${inputJson}.`;
    if (Option.isSome(recurring) && recurring.value.payload.edit.kind === "lifecycle") {
      const friendly = yield* describeRecurringLifecycle({
        db,
        userId,
        command: recurring.value.payload,
      });
      if (Option.isNone(friendly)) return Option.none();
      description = friendly.value;
    }
    return Schema.decodeOption(TranscriptText)(`${description}\nResponde exactamente: ${command}`);
  });

const Row = Schema.Struct({
  command: HostedTurnConfirmation.fields.command,
  input_json: Schema.String,
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
        .prepare(`SELECT command, input_json
      FROM hosted_confirmations c WHERE user_id=? AND issued_turn_id=? AND operation=?
      AND consumed_turn_id IS NULL AND expires_at_ms>?
      AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id=c.issued_turn_id)
      ORDER BY issued_at_ms DESC, rowid DESC LIMIT 1`)
        .bind(userId, turnId, operationId, now)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Row)(raw);
    const input = Schema.decodeOption(Schema.fromJsonString(Input))(row.input_json);
    return Option.isSome(input) && input.value.payload.edit.kind === "lifecycle"
      ? Option.some({ command: row.command })
      : Option.none();
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
