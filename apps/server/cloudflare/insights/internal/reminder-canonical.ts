import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import {
  RecurringDigestReport,
  RecurringDigestReportParams,
  ReminderSchedule,
  type ReminderScheduleEdit,
} from "../../../src/core/insights/contract";
import {
  prepareAuthorizedAuditCall,
  prepareBrowserAuditBudgetGuard,
  recordCanonicalPATWork,
  recordedPATCallProof,
} from "../../../src/shell/audit/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  type PreparedCanonicalMutation,
} from "../../canonical-operations/contract";
import {
  type QueryCaller,
  type TransactionCaller,
  auditLimitRefusal,
  callerAuthority,
  callerScope,
  childCaller,
  transactionFailure,
  transactionId,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { recordAuditedPATUseFromAuthority } from "../../../src/shell/tokens/operations";
import { decodeScheduleSnapshot, findSchedule, prepareRevisionWrites } from "./reminder-schedule";

import { type ReminderCanonicalWork as Work } from "../contract";

type Operation =
  | "insights.getReminderSchedule"
  | "insights.updateReminderSchedule"
  | "insights.getRecurringDigestReport";
const authorize = (
  input: Readonly<{
    db: D1Database;
    subject: QueryCaller;
    current: number;
    capability: "read" | "write";
  }>
): Work => {
  const subject = childCaller({
    subject: input.subject,
    requiredScope: Option.some(input.capability),
  });
  return {
    db: input.db,
    userId: subject.userId,
    current: input.current,
    authority: callerAuthority({ subject, current: input.current }),
    requiredScope: callerScope(subject),
  };
};
const httpNotFound = 404;
const httpBadRequest = 400;
const audit = ({
  work,
  operation,
  outcome,
  afterOwnerWrite,
}: Readonly<{
  work: Work;
  operation: Operation;
  outcome: "accepted" | "rejected";
  afterOwnerWrite: boolean;
}>): ReadonlyArray<D1PreparedStatement> => {
  const id = transactionId();
  if (work.authority.table !== "pats") {
    return [
      prepareAuthorizedAuditCall({
        db: work.db,
        authority: work.authority,
        id,
        operation,
        outcome,
        current: work.current,
        afterOwnerWrite,
      }),
    ];
  }
  const statements = [
    prepareOwnedStatement({
      db: work.db,
      statement: recordCanonicalPATWork({
        authority: work.authority,
        input: { id, operation, outcome, current: work.current, afterOwnerWrite },
      }),
    }),
  ];
  if (outcome === "accepted") {
    statements.push(
      prepareOwnedStatement({
        db: work.db,
        statement: recordAuditedPATUseFromAuthority({
          authority: work.authority,
          current: work.current,
          evidence: recordedPATCallProof({ auditId: id, operation }),
        }),
      })
    );
  }
  return statements;
};
const assertion = (work: Work): D1PreparedStatement =>
  work.db
    .prepare(
      `INSERT INTO insight_mutation_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted`
    )
    .bind(...work.authority.bindings);
const instructions = (schedule: ReminderSchedule): ReminderSchedule =>
  ReminderSchedule.make({
    id: schedule.id,
    version: schedule.version,
    enabled: schedule.enabled,
    cadence: schedule.cadence,
    timing: schedule.timing,
    timeZone: schedule.timeZone,
    serviceMarket: schedule.serviceMarket,
    locale: schedule.locale,
    nextScheduledAt: schedule.nextScheduledAt,
  });

const bindUser = (work: Work): Work => ({
  ...work,
  authority: {
    ...work.authority,
    predicate: `(${work.authority.predicate}) AND user_id=?`,
    bindings: [...work.authority.bindings, work.userId],
  },
});

export const readHeldReminderSchedule = (input: Work): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const work = bindUser(input);
    // The credential-gated query and required Audit commit together, including an absent schedule.
    const results = yield* Effect.tryPromise(() =>
      work.db.batch([
        ...audit({
          work,
          operation: "insights.getReminderSchedule",
          outcome: "accepted",
          afterOwnerWrite: false,
        }),
        assertion(work),
        work.db
          .prepare(
            `SELECT id,version,snapshot_json,enabled,next_scheduled_at,consent_grant_id FROM reminder_schedules WHERE user_id=? AND EXISTS(SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`
          )
          .bind(work.userId, ...work.authority.bindings),
      ])
    );
    const rows = results.at(-1)?.results;
    if (rows === undefined || rows.length > 1) return transactionUnavailable();
    const raw = rows[0];
    if (raw === undefined) {
      return Response.json({ data: null, next: [] }, { headers: { "cache-control": "no-store" } });
    }
    const snapshot = yield* decodeScheduleSnapshot({ raw, userId: UserId.make(work.userId) });
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(ReminderSchedule))(
      instructions(snapshot)
    );
    return Response.json({ data, next: [] }, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const refusal = (
  work: Work,
  code: "not_found" | "validation_failed"
): CanonicalMutationRefusal => ({
  code,
  message:
    code === "not_found"
      ? "Reminder schedule unavailable."
      : "Reminder revision changed. Read the schedule before retrying.",
  record: () =>
    Effect.tryPromise(() =>
      work.db.batch([
        ...audit({
          work,
          operation: "insights.updateReminderSchedule",
          outcome: "rejected",
          afterOwnerWrite: false,
        }),
        assertion(work),
      ])
    ).pipe(
      Effect.map(() => "recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? httpNotFound : httpBadRequest,
        message:
          code === "not_found"
            ? "Reminder schedule unavailable."
            : "Reminder revision changed. Read the schedule before retrying.",
      })
    ),
});
const readCommitted = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  findSchedule({ db, userId: UserId.make(userId) }).pipe(
    Effect.map(
      Option.map((snapshot) => {
        const payload = instructions(snapshot);
        return {
          _tag: "Owner" as const,
          payload,
          encode: () => Schema.encodeEffect(Schema.toCodecJson(ReminderSchedule))(payload),
        };
      })
    ),
    Effect.orElseSucceed(() => Option.none())
  );
const readRevisionAuthority = (
  work: ReturnType<typeof bindUser>
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    work.db
      .prepare(`SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate}`)
      .bind(...work.authority.bindings)
      .first()
  ).pipe(Effect.map((row) => row !== null));

export const prepareHeldReminderRevision = (
  input: Work & Readonly<{ input: ReminderScheduleEdit }>
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const work = { ...bindUser(input), input: input.input };
    const authority = yield* readRevisionAuthority(work);
    if (!authority) return { _tag: "CredentialRefused" } as const;
    const schedule = yield* findSchedule({ db: work.db, userId: UserId.make(work.userId) });
    if (Option.isNone(schedule)) {
      return { _tag: "Refused", refusal: refusal(work, "not_found") } as const;
    }
    if (schedule.value.version !== work.input.expectedVersion) {
      return { _tag: "Refused", refusal: refusal(work, "validation_failed") } as const;
    }
    const writes = yield* prepareRevisionWrites({
      db: work.db,
      userId: UserId.make(work.userId),
      input: work.input,
      now: DateTime.makeUnsafe(work.current),
      authority: Option.some({
        sql: `SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate}`,
        params: work.authority.bindings,
      }),
    });
    return {
      _tag: "Prepared",
      mutation: {
        oauthReview: Option.none(),
        requiredScope: work.requiredScope,
        outcome: {
          _tag: "Owner",
          operation: "insights.updateReminderSchedule",
          collisionKey: Option.some(`reminder:${work.userId}`),
          guardFacts: Option.none(),
          read: readCommitted,
          triggerRefusal: (_ownerWork, kind) =>
            kind === "audit" ? Option.some(auditLimitRefusal()) : Option.none(),
        },
        statements: [
          ...writes,
          ...audit({
            work,
            operation: "insights.updateReminderSchedule",
            outcome: "accepted",
            afterOwnerWrite: true,
          }),
        ],
        auditBudget: work.authority.table === "pats" ? "shared" : "owner",
        commitGuards:
          work.authority.table === "pats"
            ? Option.none()
            : Option.some((input) => [
                prepareBrowserAuditBudgetGuard({ ...input, owner: "insights" }),
              ]),
        guardRefusal: () => Effect.succeed(refusal(work, "validation_failed")),
      } satisfies PreparedCanonicalMutation,
    } as const;
  }).pipe(Effect.orElseSucceed(() => ({ _tag: "Failed" }) as const));

export const readCanonicalReminderSchedule = (
  input: Readonly<{ db: D1Database; subject: QueryCaller; current: number }>
): Effect.Effect<Response> => readHeldReminderSchedule(authorize({ ...input, capability: "read" }));
export const prepareCanonicalReminderRevision = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    current: number;
    input: ReminderScheduleEdit;
  }>
): Effect.Effect<CanonicalMutationPreparation> =>
  prepareHeldReminderRevision({
    ...authorize({ ...input, capability: "write" }),
    input: input.input,
  });
export const reminderRevisionRefusal = (
  input: Readonly<{ db: D1Database; subject: TransactionCaller; current: number }>
): CanonicalMutationRefusal =>
  refusal(authorize({ ...input, capability: "write" }), "validation_failed");

const rejectInvalidDigestIdentifier = (work: Work): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      work.db.batch([
        ...audit({
          work,
          operation: "insights.getRecurringDigestReport",
          outcome: "rejected",
          afterOwnerWrite: false,
        }),
        assertion(work),
      ])
    );
    return transactionFailure({
      code: "validation_failed",
      status: httpBadRequest,
      message: "Invalid recurring report identifier.",
    });
  });

/** Exact report read and credential/accountability guards commit together; opaque ids never authorize access. */
export const readHeldRecurringDigestReport = (
  input: Work & Readonly<{ id: string }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const work = bindUser(input);
    const params = Schema.decodeOption(RecurringDigestReportParams)({ id: input.id });
    if (Option.isNone(params)) return yield* rejectInvalidDigestIdentifier(work);
    const results = yield* Effect.tryPromise(() =>
      work.db.batch([
        ...audit({
          work,
          operation: "insights.getRecurringDigestReport",
          outcome: "accepted",
          afterOwnerWrite: false,
        }),
        assertion(work),
        work.db
          .prepare(
            `SELECT report_json FROM recurring_digest_reports WHERE user_id=? AND insight_event_id=? AND EXISTS(SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`
          )
          .bind(work.userId, params.value.id, ...work.authority.bindings),
      ])
    );
    const rows = results.at(-1)?.results;
    if (rows === undefined || rows.length > 1) return transactionUnavailable();
    const raw = rows[0];
    if (raw === undefined) {
      return transactionFailure({
        code: "not_found",
        status: httpNotFound,
        message: "Recurring report unavailable.",
      });
    }
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        report_json: Schema.fromJsonString(Schema.toCodecJson(RecurringDigestReport)),
      })
    )(raw);
    if (row.report_json.insightEventId !== params.value.id) return transactionUnavailable();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(RecurringDigestReport))(
      row.report_json
    );
    return Response.json({ data, next: [] }, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

export const readCanonicalRecurringDigestReport = (
  input: Readonly<{ db: D1Database; subject: QueryCaller; current: number; id: string }>
): Effect.Effect<Response> =>
  readHeldRecurringDigestReport({ ...authorize({ ...input, capability: "read" }), id: input.id });
