import { type Cause, Effect, Option, Schema } from "effect";
import {
  CanonicalToolEvidence,
  CanonicalToolOutcome,
  ToolCallId,
  type TranscriptTurnId,
} from "../../../src/core/agent/contract";
import type { UserId } from "../../../src/core/identity/contract";

const ConfirmationOutcome = Schema.Union([
  Schema.TaggedStruct("Recorded", { outcome: CanonicalToolOutcome }),
  Schema.TaggedStruct("CommitUnrecorded", {}),
]);
type ConfirmationOutcome = typeof ConfirmationOutcome.Type;
/** Preserve a retained result, or report a proven commit without inventing its lost response. */
export const confirmedOutcome = (retained: ConfirmationOutcome): CanonicalToolOutcome =>
  retained._tag === "Recorded" ? retained.outcome : { _tag: "CommittedOutputUnavailable" };

type ConfirmationWork = Readonly<{ db: D1Database; userId: UserId; turnId: TranscriptTurnId }>;
/** Recover this Turn's retained call identity only when its exact operation and input agree. */
export const findConfirmedCall = ({
  db,
  userId,
  turnId,
  operation,
  input,
}: ConfirmationWork & Readonly<{ operation: string; input: CanonicalToolEvidence }>): Effect.Effect<
  Option.Option<ToolCallId>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(input);
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT tool_call_id FROM transcript_entries WHERE user_id=? AND turn_id=? AND kind='tool_call' AND operation=? AND input_json=? AND iteration=1"
        )
        .bind(userId, turnId, operation, json)
        .first()
    );
    if (row === null) return Option.none();
    return Option.some(
      (yield* Schema.decodeUnknownEffect(Schema.Struct({ tool_call_id: ToolCallId }))(row))
        .tool_call_id
    );
  });
/** A retained result or commit fence is decisive; neither permits repeating the mutation. */
export const findConfirmedOutcome = ({
  db,
  userId,
  turnId,
  toolCallId,
}: ConfirmationWork & Readonly<{ toolCallId: ToolCallId }>): Effect.Effect<
  Option.Option<ConfirmationOutcome>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT outcome_json FROM transcript_entries WHERE user_id=? AND turn_id=? AND kind='tool_result' AND tool_call_id=?"
        )
        .bind(userId, turnId, toolCallId)
        .first()
    );
    if (row !== null) {
      const stored = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ outcome_json: Schema.fromJsonString(CanonicalToolOutcome) })
      )(row);
      return Option.some({ _tag: "Recorded", outcome: stored.outcome_json });
    }
    const committed = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT 1 FROM hosted_mutation_commits WHERE user_id=? AND turn_id=? AND tool_call_id=?"
        )
        .bind(userId, turnId, toolCallId)
        .first()
    );
    return committed === null ? Option.none() : Option.some({ _tag: "CommitUnrecorded" });
  });
