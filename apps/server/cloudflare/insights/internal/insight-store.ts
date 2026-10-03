import { DueInsight, InsightUnavailable } from "../contract";
import { allowedInsightTransitions } from "../../../src/core/insights/operations";
import { UserId } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  prepareBrowserAuditBudgetGuard,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import {
  type DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  InsightEventId,
  type InsightGenerationInput,
  InsightLifecycleState,
} from "../../../src/core/insights/contract";
import {
  type TransactionCaller,
  auditLimitRefusal,
  callerAuthority,
  callerScope,
  failedPreparation,
  isPATCaller,
  refusedPreparation,
  transactionFailure,
  transactionId,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  type GuardRefusalWork,
  type OwnerOutcome,
} from "../../canonical-operations/contract";

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
export const findInsight = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: InsightEventId;
}>): Effect.Effect<Option.Option<InsightEvent>, InsightUnavailable> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT id, kind, schedule_id, schedule_version, service_market,
    locale, time_zone, scheduled_at, money_groups_json, lifecycle_state FROM insight_events
    WHERE user_id = ? AND id = ?`)
      .bind(userId, id)
      .first()
  ).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(Option.none<InsightEvent>());
      const event = decodeEvent(raw);
      return Option.isSome(event) ? Effect.succeed(event) : Effect.fail(new InsightUnavailable());
    }),
    Effect.mapError(() => new InsightUnavailable())
  );

/** Insert one immutable scheduled occurrence; replay returns the original, never rewrites context. */
export const generateInsight = ({
  db,
  userId,
  input,
}: Readonly<{
  db: D1Database;
  userId: string;
  input: InsightGenerationInput;
}>): Effect.Effect<Option.Option<InsightEvent>, InsightUnavailable> =>
  Effect.gen(function* () {
    const groups = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(InsightEvent.fields.moneyGroups))
    )(input.moneyGroups);
    const scheduledAt = DateTime.formatIso(input.scheduledAt);
    const id = InsightEventId.make(transactionId());
    yield* Effect.tryPromise(() =>
      prepareUserContext({
        db,
        userId: UserId.make(userId),
        statement: {
          sql: `INSERT INTO insight_events
      (id, user_id, kind, schedule_id, schedule_version, service_market, locale, time_zone,
       scheduled_at, money_groups_json) SELECT ?, userId, ?, ?, ?, ?, ?, ?, ?, ? FROM identity_user_context
       WHERE userId = ? ON CONFLICT(user_id, schedule_id, schedule_version, scheduled_at) DO NOTHING`,
          params: [
            id,
            input.kind,
            input.scheduleId,
            input.scheduleVersion,
            input.serviceMarket,
            input.locale,
            input.timeZone,
            scheduledAt,
            groups,
            userId,
          ],
        },
      }).run()
    );
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id FROM insight_events WHERE user_id = ?
      AND schedule_id = ? AND schedule_version = ? AND scheduled_at = ?`)
        .bind(userId, input.scheduleId, input.scheduleVersion, scheduledAt)
        .first()
    );
    if (row === null) return Option.none<InsightEvent>();
    const identity = Schema.decodeUnknownOption(Schema.Struct({ id: InsightEventId }))(row);
    if (Option.isNone(identity)) return yield* new InsightUnavailable();
    return yield* findInsight({ db, userId, id: identity.value.id });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Global due lookup reveals only bounded identities; the User coordinator must re-read the event. */
export const discoverDueInsights = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: DateTime.Utc }>): Effect.Effect<
  Option.Option<ReadonlyArray<DueInsight>>
> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT user_id AS userId, id FROM insight_events
  WHERE lifecycle_state = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT 64`)
      .bind(DateTime.formatIso(now))
      .all()
  ).pipe(
    Effect.map((result) => Schema.decodeUnknownOption(Schema.Array(DueInsight))(result.results)),
    Effect.orElseSucceed(() => Option.none())
  );

type InsightOperation =
  | "insights.listPendingInsights"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight";
type MutationOperation = Exclude<InsightOperation, "insights.listPendingInsights">;

type InsightCall = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: InsightOperation;
  outcome: "accepted" | "rejected";
  current: number;
}>;

/** Compose required accountability with the caller-owned read or mutation. */
const insightAuditStatement = ({
  db,
  subject,
  operation,
  outcome,
  current,
  afterOwnerWrite,
}: InsightCall & Readonly<{ afterOwnerWrite: boolean }>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
          input: { id: transactionId(), current, operation, outcome, afterOwnerWrite },
        }),
      })
    : prepareAuthorizedAuditCall({
        db,
        authority,
        id: transactionId(),
        operation,
        outcome,
        current,
        afterOwnerWrite,
      });
};

/** Account for the live caller inside the same unit as the query or refusal it attests. */
const insightCallStatements = (input: InsightCall): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, current } = input;
  const authority = callerAuthority({ subject, current });
  return [
    ...(isPATCaller(subject)
      ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
      : []),
    insightAuditStatement({ ...input, afterOwnerWrite: false }),
    db
      .prepare(`INSERT INTO insight_mutation_assertion (id, accepted)
      VALUES (1, CASE WHEN changes() = 1 AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`)
      .bind(...authority.bindings),
  ];
};

/** Record a refusal only under the live caller; failed authority leaves no partial accountability. */
const recordInsightCall = (input: InsightCall): Effect.Effect<"recorded" | "unavailable"> =>
  Effect.tryPromise(() => input.db.batch([...insightCallStatements(input)])).pipe(
    Effect.map(() => "recorded" as const),
    Effect.orElseSucceed(() => "unavailable" as const)
  );

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
  input: InsightCall,
  cursor: Readonly<{ scheduledAt: string; id: string }>
): Effect.Effect<
  Option.Option<Readonly<{ events: ReadonlyArray<InsightEvent>; hasMore: boolean }>>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const { db, subject, current } = input;
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        ...insightCallStatements(input),
        db
          .prepare(`SELECT id, kind, schedule_id, schedule_version,
          service_market, locale, time_zone, scheduled_at, money_groups_json, lifecycle_state
          FROM insight_events WHERE user_id = ? AND lifecycle_state = 'pending'
          AND scheduled_at <= ? AND (scheduled_at, id) > (?, ?)
          ORDER BY scheduled_at, id LIMIT ${maximumPendingInsights + 1}`)
          .bind(
            subject.userId,
            DateTime.formatIso(DateTime.makeUnsafe(current)),
            cursor.scheduledAt,
            cursor.id
          ),
      ])
    );
    const rows = results.at(-1);
    if (rows === undefined) return Option.none();
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
    const call: InsightCall = {
      db,
      subject,
      operation: "insights.listPendingInsights",
      outcome: "accepted",
      current: transactionNow(),
    };
    const url = new URL(request.url);
    const cursor = pendingCursor(url);
    if (Option.isNone(cursor)) {
      if ((yield* recordInsightCall(call)) !== "recorded") return transactionUnavailable();
      return transactionFailure({
        code: "validation_failed",
        status: HTTP_BAD_REQUEST,
        message: "Invalid InsightEvent cursor.",
      });
    }
    const page = yield* pendingPage(call, cursor.value);
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
const allowed = (target: InsightLifecycleState): ReadonlyArray<InsightLifecycleState> =>
  InsightLifecycleState.literals.filter((current) =>
    allowedInsightTransitions(current).includes(target)
  );

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
  id: InsightEventId;
  current: number;
}> &
  (
    | Readonly<{
        operation: "insights.markInsightDelivered";
        evidence: DeliveryEvidenceInput;
      }>
    | Readonly<{
        operation: "insights.markInsightRead" | "insights.dismissInsight";
      }>
  );

const sendStatement = (
  input: TransitionInput,
  attemptId: InsightDeliveryAttempt["id"],
  sent: DeliveryEvidenceInput
): D1PreparedStatement => {
  const { db, subject, id } = input;
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

const insightGuardRefusal =
  (input: TransitionInput) =>
  ({ db, subject, current }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> =>
    findInsight({ db, userId: subject.userId, id: input.id }).pipe(
      Effect.map((event) =>
        insightRefusal({
          db,
          subject,
          current,
          operation: input.operation,
          code: Option.isNone(event) ? "not_found" : "validation_failed",
        })
      ),
      Effect.orElseSucceed(() => ({
        code: "unavailable" as const,
        message: "Insight temporarily unavailable.",
        record: () => Effect.succeed("unavailable" as const),
        respond: () => Effect.succeed(transactionUnavailable()),
      }))
    );

/** Assert the Insight owner's browser Audit limit before its write, naming this exact child. */
const insightCommitGuards = ({
  db,
  userId,
  current,
  index,
  operation,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  index: number;
  operation: string;
}>): ReadonlyArray<D1PreparedStatement> => [
  prepareBrowserAuditBudgetGuard({ db, owner: "insights", userId, current, index, operation }),
];

const findCommittedInsight = ({
  db,
  userId,
  insightEventId,
  attemptId,
}: Readonly<{
  db: D1Database;
  userId: string;
  insightEventId: InsightEventId;
  attemptId: Option.Option<InsightDeliveryAttempt["id"]>;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    const event = yield* findInsight({ db, userId, id: insightEventId });
    if (Option.isNone(event)) return Option.none<CommittedMutationValue>();
    if (Option.isNone(attemptId)) {
      const insight = event.value;
      return Option.some({
        _tag: "Owner" as const,
        next: [],
        payload: insight,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(InsightEvent))(insight),
      });
    }
    const attempt = yield* findInsightAttempt({ db, userId, id: insightEventId });
    return Option.map(
      Option.filter(attempt, (found) => found.id === attemptId.value),
      (deliveryAttempt) => {
        const payload = { insight: event.value, deliveryAttempt };
        return {
          _tag: "Owner" as const,
          next: [],
          payload,
          encode: () =>
            Schema.encodeEffect(
              Schema.toCodecJson(
                Schema.Struct({ insight: InsightEvent, deliveryAttempt: InsightDeliveryAttempt })
              )
            )(payload),
        };
      }
    );
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const insightOutcome = ({
  operation,
  insightEventId,
  attemptId,
}: Readonly<{
  operation: TransitionInput["operation"];
  insightEventId: InsightEventId;
  attemptId: Option.Option<InsightDeliveryAttempt["id"]>;
}>): OwnerOutcome => ({
  _tag: "Owner",
  operation,
  guardFacts: Option.none(),
  collisionKey: Option.none(),
  read: (db, userId) => findCommittedInsight({ db, userId, insightEventId, attemptId }),
  triggerRefusal: (_work, kind) =>
    kind === "audit" ? Option.some(auditLimitRefusal()) : Option.none(),
});

const transitionStatements = (
  input: TransitionInput
): Extract<CanonicalMutationPreparation, { _tag: "Prepared" }> => {
  const { db, subject, id, operation, current } = input;
  const target = targetOf(operation);
  const authority = callerAuthority({ subject, current });
  const write = db
    .prepare(`UPDATE insight_events SET lifecycle_state = ? WHERE user_id = ? AND id = ?
    AND lifecycle_state IN (${allowed(target)
      .map(() => "?")
      .join(",")})
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(target, subject.userId, id, ...allowed(target), ...authority.bindings);
  const delivery =
    input.operation === "insights.markInsightDelivered"
      ? Option.some({
          id: InsightDeliveryAttempt.fields.id.make(transactionId()),
          evidence: input.evidence,
        })
      : Option.none();
  const attemptId = Option.map(delivery, (attempt) => attempt.id);
  return {
    _tag: "Prepared",
    mutation: {
      requiredScope: callerScope(subject),
      outcome: insightOutcome({ operation, insightEventId: id, attemptId }),
      guardRefusal: insightGuardRefusal(input),
      auditBudget: isPATCaller(subject) ? "shared" : "owner",
      commitGuards: isPATCaller(subject) ? Option.none() : Option.some(insightCommitGuards),
      statements: [
        ...(isPATCaller(subject)
          ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
          : []),
        write,
        ...Option.toArray(
          Option.map(delivery, (value) => sendStatement(input, value.id, value.evidence))
        ),
        insightAuditStatement({
          db,
          subject,
          operation,
          current,
          outcome: "accepted",
          afterOwnerWrite: true,
        }),
      ],
    },
  };
};

/** Prepare a guarded transition, its immutable send evidence, and its success Audit as one unit. */
export const prepareInsightTransition = (
  input: TransitionInput
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const { db, subject, operation, id, current } = input;
    const event = yield* findInsight({ db, userId: subject.userId, id });
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
export const findInsightAttempt = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: InsightEventId;
}>): Effect.Effect<Option.Option<InsightDeliveryAttempt>, InsightUnavailable> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT id, insight_event_id, sent_at, channel, provider,
    provider_message_id FROM insight_delivery_attempts WHERE user_id = ? AND insight_event_id = ?`)
      .bind(userId, id)
      .first()
  ).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(Option.none<InsightDeliveryAttempt>());
      const attempt = Option.flatMap(Schema.decodeUnknownOption(AttemptRow)(raw), (row) =>
        Schema.decodeOption(InsightDeliveryAttempt)({
          id: row.id,
          insightEventId: row.insight_event_id,
          sentAt: row.sent_at,
          channel: row.channel,
          provider: row.provider,
          providerMessageId: row.provider_message_id,
        })
      );
      return Option.isSome(attempt)
        ? Effect.succeed(attempt)
        : Effect.fail(new InsightUnavailable());
    }),
    Effect.mapError(() => new InsightUnavailable())
  );
