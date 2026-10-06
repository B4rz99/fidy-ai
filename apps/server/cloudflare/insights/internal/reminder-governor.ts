import { type Cause, Effect, Option, Schema } from "effect";
import { ReminderStanding } from "../../../src/core/insights/contract";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import type { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { proactivityVerifiedControlQuery } from "../../whatsapp/operations";
import { currentProactivityGrantQuery, prepareConsentAction } from "../../consent/operations";
import { InsightUnavailable } from "../contract";

type Scope = Readonly<{ db: D1Database; userId: UserId }>;
export const findGovernor = (
  input: Scope
): Effect.Effect<Option.Option<ReminderStanding>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT standing_json FROM reminder_governors WHERE user_id=?",
          params: [input.userId],
        },
      }).first()
    );
    return raw === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              standing_json: Schema.fromJsonString(Schema.toCodecJson(ReminderStanding)),
            })
          )(raw)).standing_json
        );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
/** A single verified message is counted at most once; questions never count as reminders. */
export const prepareDelivery = (
  input: Scope & Readonly<{ id: string; proof: OwnedStatement }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      `INSERT OR IGNORE INTO reminder_delivery_receipts(user_id,delivery_id) SELECT v.user_id,v.delivery_id FROM (${input.proof.sql}) AS v JOIN reminder_governors AS g ON g.user_id=v.user_id WHERE v.user_id=? AND v.delivery_id=? AND v.role IN ('manual-entry-reminder','reminder-question') AND v.delivered_at_ms>g.last_reply_at_ms`
    )
    .bind(...input.proof.params, input.userId, input.id),
  input.db
    .prepare(
      `UPDATE reminder_governors SET standing_json=CASE WHEN (SELECT role FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?)='reminder-question' THEN CASE WHEN json_extract(standing_json,'$._tag')='QuestionPending' AND question_id=? THEN json_object('_tag','QuestionDelivered','unanswered',3) ELSE standing_json END WHEN json_extract(standing_json,'$._tag')='Attentive' AND json_extract(standing_json,'$.unanswered')<2 THEN json_object('_tag','Attentive','unanswered',json_extract(standing_json,'$.unanswered')+1) WHEN json_extract(standing_json,'$._tag')='Attentive' THEN json_object('_tag','QuestionPending','unanswered',3) WHEN json_extract(standing_json,'$._tag')='QuestionDelivered' AND (SELECT delivered_at_ms FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?)>question_delivered_at_ms THEN CASE WHEN json_extract(standing_json,'$.unanswered')=3 THEN json_object('_tag','QuestionDelivered','unanswered',4) ELSE json_object('_tag','Paused','unanswered',5,'pausedAt',(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',delivered_at_ms/1000.0,'unixepoch') FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?)) END ELSE standing_json END,question_delivered_at_ms=CASE WHEN question_id=? THEN coalesce(question_delivered_at_ms,(SELECT delivered_at_ms FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?)) ELSE question_delivered_at_ms END,notice_completed=0 WHERE user_id=? AND changes()=1`
    )
    .bind(
      ...input.proof.params,
      input.userId,
      input.id,
      input.id,
      ...input.proof.params,
      input.userId,
      input.id,
      ...input.proof.params,
      input.userId,
      input.id,
      input.id,
      ...input.proof.params,
      input.userId,
      input.id,
      input.userId
    ),
];
export const prepareReply = (
  input: Scope & Readonly<{ proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE reminder_governors SET standing_json=json_object('_tag','Attentive','unanswered',0),last_reply_at_ms=(SELECT max(v.occurred_at_ms) FROM (${input.proof.sql}) AS v WHERE v.user_id=?),question_id=NULL,question_delivered_at_ms=NULL,notice_turn_id=NULL,notice_completed=0 WHERE user_id=? AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.role IN ('manual-entry-reminder','reminder-question') AND v.occurred_at_ms>last_reply_at_ms AND v.occurred_at_ms+1000>=v.delivered_at_ms)`
    )
    .bind(...input.proof.params, input.userId, input.userId, ...input.proof.params, input.userId);
const controlChoice = Schema.Tuple([
  Schema.Literal("reminder"),
  Schema.String.check(Schema.isUUID()),
  Schema.Literals(["continue", "stop"]),
]);
const liveControlQuery = (
  proof: WhatsAppTurnAdmission,
  id: string,
  now: number
): OwnedStatement => {
  const control = proactivityVerifiedControlQuery({ proof, id, now });
  const grant = currentProactivityGrantQuery({
    userId: proof.userId,
    kind: "manual-entry-reminder",
  });
  return {
    sql: `SELECT v.user_id,v.delivery_id FROM (${control.sql}) AS v WHERE v.consent_grant_id IN (SELECT id FROM (${grant.sql}))`,
    params: [...control.params, ...grant.params],
  };
};
const hasControlReceipt = (
  input: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission }>,
  association: OwnedStatement
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        `SELECT 1 FROM reminder_control_receipts WHERE user_id=? AND message_id=? AND choice=? AND EXISTS (${association.sql})`
      )
      .bind(input.proof.userId, input.proof.messageId, input.proof.text, ...association.params)
      .first()
  ).pipe(Effect.map((row) => row !== null));

export const controlReminder = (
  input: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission; now: number }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(controlChoice)(input.proof.text.split(":"));
    if (Option.isNone(choice)) return false;
    const { proof } = input;
    const association = whatsAppAssociationQuery({
      userId: proof.userId,
      caller: { businessPortfolioId: proof.portfolioId, businessScopedUserId: proof.bsuid },
    });
    const liveControl = liveControlQuery(proof, choice.value[1], input.now);
    const evidence = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT 1 FROM (${liveControl.sql}) WHERE 1=1`)
        .bind(...liveControl.params)
        .first()
    );
    if (evidence === null) return false;
    if (yield* hasControlReceipt(input, association)) return true;
    const accepted = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT 1 FROM reminder_governors WHERE user_id=? AND question_id=? AND EXISTS (${association.sql})`
        )
        .bind(proof.userId, choice.value[1], ...association.params)
        .first()
    );
    if (accepted === null) return false;
    yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            `INSERT INTO reminder_control_receipts(user_id,message_id,choice) SELECT ?,?,? WHERE EXISTS (${association.sql}) AND EXISTS (SELECT 1 FROM reminder_governors WHERE user_id=? AND question_id=?) AND EXISTS (${liveControl.sql})`
          )
          .bind(
            proof.userId,
            proof.messageId,
            proof.text,
            ...association.params,
            proof.userId,
            choice.value[1],
            ...liveControl.params
          ),
        input.db.prepare(
          "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
        ),
        input.db
          .prepare(
            "UPDATE reminder_governors SET standing_json=json_object('_tag','Attentive','unanswered',0),last_reply_at_ms=?,question_delivered_at_ms=NULL,question_id=NULL,notice_turn_id=NULL,notice_completed=0 WHERE user_id=?"
          )
          .bind(input.now, proof.userId),
        input.db
          .prepare("UPDATE reminder_schedules SET enabled=? WHERE user_id=?")
          .bind(choice.value[2] === "continue" ? 1 : 0, proof.userId),
      ])
    );
    return true;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
export const pauseMention =
  "Pausé tus recordatorios de registro manual porque no recibí respuesta. Puedes pedirme que los reactive.";
export const prepareNotice = (
  input: Scope & Readonly<{ turnId: string; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE reminder_governors SET notice_turn_id=? WHERE user_id=? AND json_extract(standing_json,'$._tag')='Paused' AND notice_completed=0 AND EXISTS (${input.proof.sql})`
    )
    .bind(input.turnId, input.userId, ...input.proof.params);
export const readNotice = (
  input: Scope & Readonly<{ turnId: string }>
): Effect.Effect<Option.Option<string>, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "SELECT 1 FROM reminder_governors WHERE user_id=? AND notice_turn_id=? AND json_extract(standing_json,'$._tag')='Paused' AND notice_completed=0"
      )
      .bind(input.userId, input.turnId)
      .first()
  ).pipe(
    Effect.map((row) => (row === null ? Option.none() : Option.some(pauseMention))),
    Effect.mapError(() => new InsightUnavailable())
  );
export const prepareNoticeCompletion = (
  input: Scope & Readonly<{ turnId: string; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE reminder_governors SET notice_completed=1 WHERE user_id=? AND notice_turn_id=? AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.turn_id=? AND instr(v.text,?)>0)`
    )
    .bind(
      input.userId,
      input.turnId,
      ...input.proof.params,
      input.userId,
      input.turnId,
      pauseMention
    );
