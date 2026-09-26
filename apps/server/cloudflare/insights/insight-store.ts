import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  type DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  InsightEventId,
  type InsightGenerationInput,
  type InsightLifecycleState,
} from "@fidy/server/insights-runtime";
import {
  type TransactionCaller,
  callerAuthority,
  callerScope,
  isPATCaller,
  transactionFailure,
  transactionId,
  transactionNow,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  failedPreparation,
  refusedPreparation,
} from "../mutations/mutation-types";

const maximumPendingInsights = 64;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

const EventRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  schedule_id: Schema.String,
  schedule_version: Schema.Finite,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  scheduled_at: Schema.String,
  money_groups_json: Schema.String,
  lifecycle_state: Schema.String,
});
const AttemptRow = Schema.Struct({
  id: Schema.String,
  insight_event_id: Schema.String,
  sent_at: Schema.String,
  channel: Schema.String,
  provider: Schema.String,
  provider_message_id: Schema.String,
});

const decodeEvent = (raw: unknown): Option.Option<InsightEvent> =>
  Option.flatMap(Schema.decodeUnknownOption(EventRow)(raw), (row) => {
    const groups = Schema.decodeOption(
      Schema.fromJsonString(Schema.toCodecJson(InsightEvent.fields.moneyGroups))
    )(row.money_groups_json);
    if (Option.isNone(groups)) return Option.none();
    return Schema.decodeOption(Schema.toCodecJson(InsightEvent))({
      id: row.id,
      kind: row.kind,
      scheduleId: row.schedule_id,
      scheduleVersion: row.schedule_version,
      serviceMarket: row.service_market,
      locale: row.locale,
      timeZone: row.time_zone,
      scheduledAt: row.scheduled_at,
      moneyGroups: Schema.encodeSync(Schema.toCodecJson(InsightEvent.fields.moneyGroups))(
        groups.value
      ),
      lifecycleState: row.lifecycle_state,
    });
  });

/** Read the authoritative occurrence for one User; an opaque id alone grants no access. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const findInsight = (
  db: D1Database,
  userId: string,
  id: InsightEventId
): Effect.Effect<Option.Option<InsightEvent>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT id, kind, schedule_id, schedule_version, service_market,
    locale, time_zone, scheduled_at, money_groups_json, lifecycle_state FROM insight_events
    WHERE user_id = ? AND id = ?`)
      .bind(userId, id)
      .first()
  ).pipe(Effect.map(decodeEvent));

/** Insert one immutable scheduled occurrence; replay returns the original, never rewrites context. */
export const generateInsight = ({
  db,
  userId,
  input,
}: Readonly<{
  db: D1Database;
  userId: string;
  input: InsightGenerationInput;
}>): Effect.Effect<Option.Option<InsightEvent>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const groups = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(InsightEvent.fields.moneyGroups))
    )(input.moneyGroups);
    const scheduledAt = DateTime.formatIso(input.scheduledAt);
    const id = InsightEventId.make(transactionId());
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO insight_events
      (id, user_id, kind, schedule_id, schedule_version, service_market, locale, time_zone,
       scheduled_at, money_groups_json) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM users
       WHERE id = ? ON CONFLICT(user_id, schedule_id, schedule_version, scheduled_at) DO NOTHING`)
        .bind(
          id,
          input.kind,
          input.scheduleId,
          input.scheduleVersion,
          input.serviceMarket,
          input.locale,
          input.timeZone,
          scheduledAt,
          groups,
          userId
        )
        .run()
    );
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id FROM insight_events WHERE user_id = ?
      AND schedule_id = ? AND schedule_version = ? AND scheduled_at = ?`)
        .bind(userId, input.scheduleId, input.scheduleVersion, scheduledAt)
        .first()
    );
    const identity = Schema.decodeUnknownOption(Schema.Struct({ id: InsightEventId }))(row);
    return Option.isSome(identity)
      ? yield* findInsight(db, userId, identity.value.id)
      : Option.none();
  });

/** Global due lookup reveals only bounded identities; the User coordinator must re-read the event. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const discoverDueInsights = (
  db: D1Database,
  now: string
): Effect.Effect<
  Option.Option<
    ReadonlyArray<{
      userId: string;
      id: InsightEventId;
    }>
  >
> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT user_id, id FROM insight_events
  WHERE lifecycle_state = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT 64`)
      .bind(now)
      .all()
  ).pipe(
    Effect.map((result) => {
      const identities: Array<{ userId: string; id: InsightEventId }> = [];
      for (const raw of result.results) {
        const row = Schema.decodeUnknownOption(
          Schema.Struct({ user_id: Schema.String.check(Schema.isUUID()), id: InsightEventId })
        )(raw);
        if (Option.isNone(row)) {
          return Option.none<ReadonlyArray<{ userId: string; id: InsightEventId }>>();
        }
        identities.push({ userId: row.value.user_id, id: row.value.id });
      }
      return Option.some(identities);
    }),
    Effect.orElseSucceed(() => Option.none())
  );

export type InsightOperation =
  | "insights.listPendingInsights"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight";
type MutationOperation = Exclude<InsightOperation, "insights.listPendingInsights">;

/** Record a query or refusal only under the live caller; no financial contents enter Audit. */
export const recordInsightCall = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: InsightOperation;
  outcome: "accepted" | "rejected";
  current: number;
}>): Effect.Effect<"recorded" | "unavailable"> => {
  if (isPATCaller(subject)) {
    return Effect.tryPromise(() =>
      db.batch([
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
        prepareOwnedStatement({
          db,
          statement: recordCanonicalPATWork({
            subject,
            input: {
              id: transactionId(),
              current,
              operation,
              outcome,
              afterOwnerWrite: false,
            },
          }),
        }),
      ])
    ).pipe(
      Effect.map((rows) =>
        rows.every((row) => row.meta.changes === 1)
          ? ("recorded" as const)
          : ("unavailable" as const)
      ),
      Effect.orElseSucceed(() => "unavailable" as const)
    );
  }
  const authority = callerAuthority({ subject, current });
  return Effect.tryPromise(() =>
    db
      .prepare(`INSERT INTO insight_audit
    (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT ?, user_id, id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(transactionId(), operation, outcome, current, ...authority.bindings)
      .run()
  ).pipe(
    Effect.map((result) =>
      result.meta.changes === 1 ? ("recorded" as const) : ("unavailable" as const)
    ),
    Effect.orElseSucceed(() => "unavailable" as const)
  );
};

const pendingCursor = (url: URL): Option.Option<Readonly<{ scheduledAt: string; id: string }>> => {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return Option.some({ scheduledAt: "", id: "" });
  const [scheduledAt, id] = raw.split("|");
  if (
    raw.split("|").length !== 2 ||
    Option.isNone(
      Schema.decodeUnknownOption(Schema.toCodecJson(InsightEvent.fields.scheduledAt))(scheduledAt)
    ) ||
    Option.isNone(Schema.decodeUnknownOption(InsightEventId)(id))
  ) {
    return Option.none();
  }
  return Option.some({ scheduledAt: scheduledAt ?? "", id: id ?? "" });
};

const pendingPage = (
  db: D1Database,
  userId: string,
  cursor: Readonly<{ scheduledAt: string; id: string }>
): Effect.Effect<
  Option.Option<Readonly<{ events: ReadonlyArray<InsightEvent>; hasMore: boolean }>>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id, kind, schedule_id, schedule_version,
    service_market, locale, time_zone, scheduled_at, money_groups_json, lifecycle_state
    FROM insight_events WHERE user_id = ? AND lifecycle_state = 'pending'
    AND scheduled_at <= ? AND (scheduled_at, id) > (?, ?)
    ORDER BY scheduled_at, id LIMIT ${maximumPendingInsights + 1}`)
        .bind(userId, DateTime.formatIso(DateTime.nowUnsafe()), cursor.scheduledAt, cursor.id)
        .all()
    );
    const events: Array<InsightEvent> = [];
    for (const row of rows.results.slice(0, maximumPendingInsights)) {
      const event = decodeEvent(row);
      if (Option.isNone(event)) return Option.none();
      events.push(event.value);
    }
    return Option.some({ events, hasMore: rows.results.length > maximumPendingInsights });
  });

const pendingPageResponse = (
  url: URL,
  page: Readonly<{ events: ReadonlyArray<InsightEvent>; hasMore: boolean }>
): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(InsightEvent)))(
      page.events
    );
    const last = page.events.at(-1);
    if (page.hasMore && last !== undefined) {
      url.searchParams.set("cursor", `${DateTime.formatIso(last.scheduledAt)}|${last.id}`);
    }
    return Response.json(
      { data, next: [] },
      {
        headers: {
          "cache-control": "no-store",
          ...(page.hasMore ? { link: `<${url.toString()}>; rel="next"` } : {}),
        },
      }
    );
  });

/** One bounded canonical query over the same authoritative events delivery reads. */
export const listPendingInsights = ({
  db,
  subject,
  request,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  request: Request;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (
      (yield* recordInsightCall({
        db,
        subject,
        operation: "insights.listPendingInsights",
        outcome: "accepted",
        current: transactionNow(),
      })) !== "recorded"
    ) {
      return transactionUnavailable();
    }
    const url = new URL(request.url);
    const cursor = pendingCursor(url);
    if (Option.isNone(cursor)) {
      return transactionFailure({
        code: "validation_failed",
        status: HTTP_BAD_REQUEST,
        message: "Invalid InsightEvent cursor.",
      });
    }
    const page = yield* pendingPage(db, subject.userId, cursor.value);
    if (Option.isNone(page)) return transactionUnavailable();
    return yield* pendingPageResponse(url, page.value);
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const targetOf = (operation: MutationOperation): InsightLifecycleState => {
  switch (operation) {
    case "insights.markInsightDelivered":
      return "delivered";
    case "insights.markInsightRead":
      return "read";
    case "insights.dismissInsight":
      return "dismissed";
  }
};
const allowed = (target: InsightLifecycleState): ReadonlyArray<InsightLifecycleState> => {
  switch (target) {
    case "delivered":
      return ["pending"];
    case "read":
      return ["pending", "delivered"];
    case "dismissed":
      return ["pending", "delivered", "read"];
    case "pending":
      return [];
  }
};

export const insightRefusal = ({
  db,
  subject,
  operation,
  current,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MutationOperation;
  current: number;
  code: "not_found" | "validation_failed";
}>): CanonicalMutationRefusal => ({
  code,
  message: code === "not_found" ? "Insight unavailable." : "Insight transition unavailable.",
  record: () =>
    recordInsightCall({ db, subject, operation, current, outcome: "rejected" }).pipe(
      Effect.map((result) =>
        result === "recorded" ? ("recorded" as const) : ("unavailable" as const)
      )
    ),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
        message: code === "not_found" ? "Insight unavailable." : "Insight transition unavailable.",
      })
    ),
});

type TransitionInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MutationOperation;
  id: InsightEventId;
  evidence: Option.Option<DeliveryEvidenceInput>;
  current: number;
}>;

const sendStatement = (
  input: TransitionInput,
  attemptId: InsightDeliveryAttempt["id"]
): D1PreparedStatement => {
  const { db, subject, id, evidence } = input;
  const sent = Option.getOrThrow(evidence);
  return db
    .prepare(`INSERT INTO insight_delivery_attempts (id, user_id, insight_event_id, sent_at,
    channel, provider, provider_message_id) SELECT ?, user_id, id, ?, ?, ?, ? FROM insight_events
    WHERE user_id = ? AND id = ? AND lifecycle_state = 'delivered' AND changes() = 1`)
    .bind(
      attemptId,
      DateTime.formatIso(sent.sentAt),
      sent.channel,
      sent.provider,
      sent.providerMessageId,
      subject.userId,
      id
    );
};

const transitionStatements = (
  input: TransitionInput
): Extract<CanonicalMutationPreparation, { _tag: "Prepared" }> => {
  const { db, subject, id, operation, current, evidence } = input;
  const target = targetOf(operation);
  const authority = callerAuthority({ subject, current });
  const write = db
    .prepare(`UPDATE insight_events SET lifecycle_state = ? WHERE user_id = ? AND id = ?
    AND lifecycle_state IN (${allowed(target)
      .map(() => "?")
      .join(",")})
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(target, subject.userId, id, ...allowed(target), ...authority.bindings);
  const attemptId = Option.map(evidence, () =>
    InsightDeliveryAttempt.fields.id.make(transactionId())
  );
  const audit = isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: transactionId(),
            current,
            operation,
            outcome: "accepted",
            afterOwnerWrite: true,
          },
        }),
      })
    : db
        .prepare(`INSERT INTO insight_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, id, ?, 'accepted', ? FROM ${authority.table} WHERE ${authority.predicate}
      AND changes() = 1`)
        .bind(transactionId(), operation, current, ...authority.bindings);
  return {
    _tag: "Prepared",
    mutation: {
      requiredScope: callerScope(subject),
      outcome: { _tag: "Insight", operation, insightEventId: id, attemptId },
      statements: [
        ...(isPATCaller(subject)
          ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
          : []),
        write,
        ...Option.toArray(Option.map(attemptId, (value) => sendStatement(input, value))),
        audit,
      ],
      completion: db.prepare(`INSERT INTO insight_mutation_assertion (id, accepted)
      VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`),
    },
  };
};

/** Prepare a guarded transition, its immutable send evidence, and its success Audit as one unit. */
export const prepareInsightTransition = (
  input: TransitionInput
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const { db, subject, operation, id, current } = input;
    const event = yield* findInsight(db, subject.userId, id);
    if (Option.isNone(event)) {
      return refusedPreparation(
        insightRefusal({ db, subject, operation, current, code: "not_found" })
      );
    }
    if (!allowed(targetOf(operation)).includes(event.value.lifecycleState)) {
      return refusedPreparation(
        insightRefusal({ db, subject, operation, current, code: "validation_failed" })
      );
    }
    return transitionStatements(input);
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Read send evidence by User and event identity; never infer it from provider identity. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const findInsightAttempt = (
  db: D1Database,
  userId: string,
  id: InsightEventId
): Effect.Effect<Option.Option<InsightDeliveryAttempt>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT id, insight_event_id, sent_at, channel, provider,
    provider_message_id FROM insight_delivery_attempts WHERE user_id = ? AND insight_event_id = ?`)
      .bind(userId, id)
      .first()
  ).pipe(
    Effect.map((raw) =>
      Option.flatMap(Schema.decodeUnknownOption(AttemptRow)(raw), (row) =>
        Schema.decodeOption(InsightDeliveryAttempt)({
          id: row.id,
          insightEventId: row.insight_event_id,
          sentAt: row.sent_at,
          channel: row.channel,
          provider: row.provider,
          providerMessageId: row.provider_message_id,
        })
      )
    )
  );
