import { type Cause, type DateTime, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import { prepareProactivityConsentAction } from "../../consent/operations";
import {
  proactivityRejectedDeliveryQuery,
  proactivityStartedDeliveryQuery,
} from "../../whatsapp/operations";
import { newId } from "../../secret-material/operations";
import { findSchedule } from "./reminder-schedule";
import { InsightUnavailable } from "../contract";

const dayMs = 86400000;
const QuestionRow = Schema.Struct({
  question_id: Schema.OptionFromNullOr(Schema.String.check(Schema.isUUID())),
});
const findQuestionCandidate = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<typeof QuestionRow.Type>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const current = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT question_id FROM reminder_governors WHERE user_id=? AND json_extract(standing_json,'$._tag')='QuestionPending'"
        )
        .bind(input.userId)
        .first()
    );
    if (current === null) return Option.none();
    const question = yield* Schema.decodeUnknownEffect(QuestionRow)(current);
    if (Option.isNone(question.question_id)) return Option.some(question);
    const failureProof = proactivityRejectedDeliveryQuery({
      userId: input.userId,
      id: question.question_id.value,
    });
    const started = proactivityStartedDeliveryQuery();
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT question_id FROM reminder_governors AS g WHERE user_id=? AND json_extract(standing_json,'$._tag')='QuestionPending' AND (EXISTS (SELECT 1 FROM proactivity_outbox AS o WHERE o.user_id=g.user_id AND o.delivery_id=g.question_id AND o.state IN ('expired','refused') AND NOT EXISTS (SELECT 1 FROM (${started.sql}) AS c WHERE c.user_id=g.user_id AND c.delivery_id=g.question_id)) OR EXISTS (SELECT 1 FROM (${failureProof.sql}) AS f WHERE f.user_id=g.user_id AND f.delivery_id=g.question_id))`
        )
        .bind(input.userId, ...failureProof.params)
        .first()
    );
    return raw === null
      ? Option.none()
      : Option.some(yield* Schema.decodeUnknownEffect(QuestionRow)(raw));
  });
export const generateReminderQuestion = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const schedule = yield* findSchedule(input);
    if (Option.isNone(schedule) || !schedule.value.enabled) return;
    const candidate = yield* findQuestionCandidate(input);
    if (Option.isNone(candidate)) return;
    const previous = candidate.value;
    const id = newId();
    const current = schedule.value;
    const text = `Has recibido tres recordatorios sin responder. ¿Quieres continuar?\nreminder:${id}:continue\nreminder:${id}:stop`;
    yield* Effect.tryPromise(() =>
      input.db.batch([
        prepareProactivityConsentAction({
          db: input.db,
          userId: input.userId,
          kind: "manual-entry-reminder",
          grantId: current.consentGrantId,
          statement: {
            sql: "INSERT INTO proactivity_reports(delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT ?,?,'reminder-question',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reminder_governors WHERE user_id=? AND json_extract(standing_json,'$._tag')='QuestionPending' AND question_id IS NULLIF(?,''))",
            params: [
              id,
              input.userId,
              current.consentGrantId,
              text,
              input.now.epochMilliseconds,
              input.now.epochMilliseconds + dayMs,
              current.timeZone,
              input.now.epochMilliseconds,
              input.userId,
              Option.getOrElse(previous.question_id, () => ""),
            ],
          },
        }),
        input.db.prepare(
          "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
        ),
        input.db
          .prepare(
            "UPDATE reminder_governors SET question_id=?,question_delivered_at_ms=NULL WHERE user_id=?"
          )
          .bind(id, input.userId),
        input.db
          .prepare(
            "INSERT INTO proactivity_outbox(user_id,delivery_id,created_at_ms) VALUES(?,?,?)"
          )
          .bind(input.userId, id, input.now.epochMilliseconds),
      ])
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
