import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { type DateTime, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { captureConfirmationDay } from "../../../src/core/insights/operations";
import { prepareUserContext, readUserContext } from "../../identity/user-context/operations";
import { newId } from "../../secret-material/operations";
import { InsightUnavailable } from "../contract";

const ContextJson = Schema.fromJsonString(Schema.toCodecJson(UserContext));
export const InstructionRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  enabled: Schema.Literals([0, 1]),
  grant_id: ConsentRecordId,
  context_json: ContextJson,
  acceptance_from_ms: Schema.Int,
});
type Scope = Readonly<{ db: D1Database; userId: UserId }>;
export const findInstruction = (
  input: Scope
): Effect.Effect<Option.Option<typeof InstructionRow.Type>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT id,version,enabled,grant_id,context_json,acceptance_from_ms FROM (SELECT rowid,user_id,id,version,enabled,consent_grant_id AS grant_id,snapshot_json AS context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM schedules WHERE kind='digest') WHERE user_id=?"
        )
        .bind(input.userId)
        .first()
    );
    return raw === null
      ? Option.none()
      : Option.some(yield* Schema.decodeUnknownEffect(InstructionRow)(raw));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const prepareActivation = (
  input: Scope & Readonly<{ now: DateTime.Utc; grantId: ConsentRecordId }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, InsightUnavailable> =>
  Effect.gen(function* () {
    const context = yield* readUserContext({ ...input, authority: Option.none() });
    if (Option.isNone(context)) return yield* new InsightUnavailable();
    const previous = yield* findInstruction(input);
    const version = Option.match(previous, { onNone: () => 1, onSome: (row) => row.version + 1 });
    const id = Option.match(previous, { onNone: newId, onSome: (row) => row.id });
    const encoded = yield* Schema.encodeEffect(ContextJson)(context.value);
    const day = captureConfirmationDay({
      confirmedAt: input.now,
      timeZone: context.value.timeZone,
    });
    const expected = Option.match(previous, { onNone: () => 0, onSome: (row) => row.version });
    return [
      prepareUserContext({
        ...input,
        statement: {
          sql: "INSERT INTO sql_assertions (scope, accepted) SELECT 'proactivity_message',CASE WHEN EXISTS(SELECT 1 FROM identity_user_context WHERE userId=? AND serviceMarket=? AND locale=? AND timeZone=?) THEN 1 ELSE 0 END WHERE 1=1 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted",
          params: [
            input.userId,
            context.value.serviceMarket,
            context.value.locale,
            context.value.timeZone,
          ],
        },
      }),
      input.db
        .prepare(`INSERT INTO schedules(kind,user_id,id,version,enabled,consent_grant_id,snapshot_json,acceptance_from_ms,accepted_at_ms)
 SELECT 'digest',?,?,?,1,?,?,?,? WHERE coalesce((SELECT version FROM (SELECT rowid,user_id,id,version,enabled,consent_grant_id AS grant_id,snapshot_json AS context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM schedules WHERE kind='digest') WHERE user_id=?),0)=?
 ON CONFLICT(kind,user_id) DO UPDATE SET version=excluded.version,enabled=1,consent_grant_id=excluded.consent_grant_id,snapshot_json=excluded.snapshot_json,acceptance_from_ms=excluded.acceptance_from_ms,accepted_at_ms=excluded.accepted_at_ms`)
        .bind(
          input.userId,
          id,
          version,
          input.grantId,
          encoded,
          day.from.epochMilliseconds,
          input.now.epochMilliseconds,
          input.userId,
          expected
        ),
      prepareChangedRowAssertion({ db: input.db, scope: "proactivity_message" }),
    ];
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const prepareDisable = (input: Scope): D1PreparedStatement =>
  input.db
    .prepare(
      "UPDATE schedules SET enabled=0,version=version+1 WHERE kind='digest' AND user_id=? AND enabled=1"
    )
    .bind(input.userId);
