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
          "SELECT id,version,enabled,grant_id,context_json,acceptance_from_ms FROM recurring_digest_instructions WHERE user_id=?"
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
          sql: "INSERT INTO proactivity_message_assertion(id,accepted) SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM identity_user_context WHERE userId=? AND serviceMarket=? AND locale=? AND timeZone=?) THEN 1 ELSE 0 END WHERE 1=1 ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted",
          params: [
            input.userId,
            context.value.serviceMarket,
            context.value.locale,
            context.value.timeZone,
          ],
        },
      }),
      input.db
        .prepare(`INSERT INTO recurring_digest_instructions(user_id,id,version,enabled,grant_id,context_json,acceptance_from_ms,accepted_at_ms)
 SELECT ?,?,?,1,?,?,?,? WHERE coalesce((SELECT version FROM recurring_digest_instructions WHERE user_id=?),0)=?
 ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,enabled=1,grant_id=excluded.grant_id,context_json=excluded.context_json,acceptance_from_ms=excluded.acceptance_from_ms,accepted_at_ms=excluded.accepted_at_ms`)
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
      input.db.prepare(
        "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
      ),
    ];
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const prepareDisable = (input: Scope): D1PreparedStatement =>
  input.db
    .prepare(
      "UPDATE recurring_digest_instructions SET enabled=0,version=version+1 WHERE user_id=? AND enabled=1"
    )
    .bind(input.userId);
