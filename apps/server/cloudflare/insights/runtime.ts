import { materializeWeekly } from "./internal/native-weekly-summary";
import type { UserStoreBindings } from "../directory/contract";
import {
  offerWeeklyQuestions,
  prepareGovernorQuestion,
  recordWeeklyReply,
  repairWeekly,
} from "./internal/native-weekly";
import { recordReminderReply } from "./internal/local-reminder-attention";
import { withStoreCapacity } from "../runtime/sqlite/operations";
import { activeChoiceText, handleChoice } from "./internal/local-reminder-choice";
import { dispatchDisclosure } from "./internal/local-disclosure";
import type { WhatsAppTurnAdmission } from "../whatsapp/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  deliverReminder,
  offerDeliveries,
  processReminder,
  repairReminder,
} from "./internal/local-reminder";
import { evidenceRetentionDue, summariesDue } from "./internal/cadence";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { proactivityWorkflowId } from "./internal/proactivity-workflow";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { HttpClient } from "effect/http";
import { type UserId } from "../../src/core/identity/contract";
import {
  InsightTemplateConfiguration,
  WeeklyQuestionTemplateConfiguration,
} from "../../src/shell/channels/whatsapp/contract";
import {
  makeInsightTemplateSender,
  makeProactivityTemplateSender,
  makeWeeklyQuestionSender,
} from "../../src/shell/channels/whatsapp/runtime";
import {
  type OutboundHttpService,
  makeKapsoOutboundHttp,
} from "../../src/shell/outbound-http/operations";
import {
  captureTraceHeaders,
  captureWorkTrace,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  observeWorkerPromise,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import { executeWeeklyActivity, weeklyThresholds } from "./internal/weekly-execution";
import { deliverProactivity, generateProactivity } from "./internal/proactivity-execution";
import { discoverProactivityUsers, noteProactivityEvaluation } from "./internal/proactivity-work";
import {
  discoverDueWeeklySchedules,
  noteWeeklyScheduleEvaluation,
  runWeeklyGeneration,
} from "./operations";
import {
  type DueWeeklySchedule,
  InsightUnavailable,
  type NativeReminderEnvironment,
  ProactivityActivity,
  ProactivityActivityResult,
  ProactivityDeliveryWork,
  type ProactivityEnvironment,
} from "./contract";
import {
  discoverDeliveryWork,
  expireDeliveryWork,
  markOffered,
  recoverDeliveryWork,
} from "./internal/proactivity-delivery-work";
import {
  expireWeeklyQuestions,
  sweepInsightChannelEvidence,
  sweepProactivityChannelEvidence,
} from "../whatsapp/operations";

type NativeExecution = Readonly<{
  environment: ProactivityEnvironment;
  userId: UserId;
  work: ProactivityActivity;
  now: DateTime.Utc;
}>;
const nativeOutbound = (
  environment: Pick<ProactivityEnvironment, "KAPSO_API_KEY">
): Effect.Effect<OutboundHttpService, InsightUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    if (environment.KAPSO_API_KEY === undefined || environment.KAPSO_API_KEY.length === 0) {
      return yield* new InsightUnavailable();
    }
    const services = yield* Layer.build(OutboundHttpLive);
    return makeKapsoOutboundHttp({
      apiKey: Redacted.make(environment.KAPSO_API_KEY),
      httpClient: Context.get(services, HttpClient.HttpClient),
    });
  });
const executeCategory = (
  input: NativeExecution &
    Readonly<{ work: Extract<ProactivityActivity, { kind: "proactivity-delivery" }> }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    if (input.environment.PROACTIVITY_ENABLED !== "enabled") return yield* new InsightUnavailable();
    const outboundHttp = yield* nativeOutbound(input.environment);
    const configuration = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      input.environment.PROACTIVITY_TEMPLATE_JSON ?? ""
    );
    return yield* deliverProactivity({
      callbackOwner: input.environment,
      ...input,
      db: input.environment.DB,
      sender: makeProactivityTemplateSender({ configuration, outboundHttp }),
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const executeScheduledSummary = (
  input: NativeExecution &
    Readonly<{
      work: Exclude<
        ProactivityActivity,
        { kind: "proactivity-recover" | "proactivity-generate" | "proactivity-delivery" }
      >;
    }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const environment = input.environment;
    if (environment.WEEKLY_SUMMARY_ENABLED !== "enabled") return yield* new InsightUnavailable();
    yield* weeklyThresholds(environment);
    if (input.work.kind === "weekly-generate") {
      if (input.work.userId !== input.userId) return yield* new InsightUnavailable();
      yield* runWeeklyGeneration({
        db: environment.DB,
        userId: input.userId,
        id: input.work.id,
        now: input.now,
      });
      return { _tag: "Done" } as const;
    }
    const summaryConfiguration = yield* Schema.decodeEffect(
      Schema.fromJsonString(InsightTemplateConfiguration)
    )(environment.WEEKLY_SUMMARY_TEMPLATE_JSON ?? "");
    const questionConfiguration = yield* Schema.decodeEffect(
      Schema.fromJsonString(WeeklyQuestionTemplateConfiguration)
    )(environment.WEEKLY_QUESTION_TEMPLATE_JSON ?? "");
    const outboundHttp = yield* nativeOutbound(environment);
    return yield* executeWeeklyActivity({
      callbackOwner: environment,
      ...input,
      work: input.work,
      db: environment.DB,
      senders: {
        summary: makeInsightTemplateSender({ configuration: summaryConfiguration, outboundHttp }),
        question: makeWeeklyQuestionSender({ configuration: questionConfiguration, outboundHttp }),
      },
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Construct approved senders only at the native composition publication. */
export const executeProactivityWork = (
  input: Readonly<{
    environment: ProactivityEnvironment;
    userId: UserId;
    work: ProactivityActivity;
    now: DateTime.Utc;
  }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment = input.environment;
      if (input.work.kind === "proactivity-recover") {
        const admitted = yield* recoverDeliveryWork({
          db: environment.DB,
          userId: input.userId,
          work: input.work.work,
          now: input.now.epochMilliseconds,
        });
        return admitted ? ({ _tag: "RecoveryAdmitted" } as const) : ({ _tag: "Done" } as const);
      }
      if (input.work.kind === "proactivity-generate") {
        if (environment.PROACTIVITY_ENABLED !== "enabled") return yield* new InsightUnavailable();
        return yield* generateProactivity({ ...input, db: environment.DB, work: input.work });
      }
      if (input.work.kind === "proactivity-delivery") {
        return yield* executeCategory({ ...input, work: input.work });
      }
      return yield* executeScheduledSummary({ ...input, work: input.work });
    })
  ).pipe(Effect.mapError(() => new InsightUnavailable()));

type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
type ProactivityBackgroundEnvironment = ProactivityEnvironment &
  Readonly<{ USER_TRANSACTION_COORDINATOR: Coordinator }> &
  Partial<
    Readonly<{
      WEEKLY_DELIVERY_QUEUE: Pick<Queue<ProactivityDeliveryWork>, "send">;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<ProactivityDeliveryWork>;
    }>
  >;

const runActivity = (
  input: Readonly<{ coordinator: Coordinator; work: ProactivityActivity }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const traceHeaders = yield* captureTraceHeaders;
    const headers = new Headers({ "content-type": "application/json", ...traceHeaders });
    const safeWork = yield* sanitizeWorkTrace(input.work);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ProactivityActivity))(safeWork);
    const response = yield* Effect.tryPromise((signal) =>
      input.coordinator.getByName(input.work.userId).fetch("https://coordinator/proactivity-work", {
        method: "POST",
        headers,
        body,
        signal,
      })
    );
    if (!response.ok) return yield* new InsightUnavailable();
    return yield* Schema.decodeUnknownEffect(ProactivityActivityResult)(
      yield* Effect.tryPromise(() => response.json())
    );
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new InsightUnavailable())
  );

const attemptIndependent = (
  activities: ReadonlyArray<Effect.Effect<unknown, Error>>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.partition(activities, (activity) => activity, { concurrency: 1 }).pipe(
    Effect.flatMap(([, failures]) =>
      failures.length > 0 ? Effect.fail(new InsightUnavailable()) : Effect.void
    )
  );
const maximumWeeklyGenerationsPerSweep = 4;
const attemptGeneration = (
  input: Readonly<{
    environment: ProactivityBackgroundEnvironment;
    now: DateTime.Utc;
    schedule: DueWeeklySchedule;
  }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    yield* noteWeeklyScheduleEvaluation({
      db: input.environment.DB,
      ...input.schedule,
      now: input.now,
    });
    return yield* runActivity({
      coordinator: input.environment.USER_TRANSACTION_COORDINATOR,
      work: { kind: "weekly-generate", version: 1, ...input.schedule },
    });
  });
const generateDueWeeklyWork = (
  input: Readonly<{ environment: ProactivityBackgroundEnvironment; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.environment.WEEKLY_SUMMARY_ENABLED !== "enabled" || !summariesDue(input.now)) return;
    const schedules = yield* discoverDueWeeklySchedules({
      db: input.environment.DB,
      now: input.now,
    });
    yield* attemptIndependent(
      schedules
        .slice(0, maximumWeeklyGenerationsPerSweep)
        .map((schedule) => attemptGeneration({ ...input, schedule }))
    );
  });
const generateDueProactivity = (
  input: Readonly<{ environment: ProactivityBackgroundEnvironment; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.environment.PROACTIVITY_ENABLED !== "enabled") return;
    const users = yield* discoverProactivityUsers({ db: input.environment.DB, now: input.now });
    yield* attemptIndependent(
      users.slice(0, maximumWeeklyGenerationsPerSweep).map((userId) =>
        Effect.gen(function* () {
          yield* noteProactivityEvaluation({ db: input.environment.DB, userId, now: input.now });
          return yield* runActivity({
            coordinator: input.environment.USER_TRANSACTION_COORDINATOR,
            work: { kind: "proactivity-generate", version: 1, userId },
          });
        })
      )
    );
  });
const publishProactivityItem = (
  input: Readonly<{
    queue: NonNullable<ProactivityBackgroundEnvironment["WEEKLY_DELIVERY_QUEUE"]>;
    db: D1Database;
    item: ProactivityDeliveryWork;
    now: DateTime.Utc;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    yield* Effect.tryPromise(() =>
      input.queue.send({ ...input.item, ...trace }, { contentType: "json" })
    );
    yield* markOffered({ db: input.db, work: input.item, now: input.now.epochMilliseconds });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
const publishProactivityWork = (
  input: Readonly<{ environment: ProactivityBackgroundEnvironment; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const { environment, now } = input;
    if (
      environment.WEEKLY_SUMMARY_ENABLED !== "enabled" &&
      environment.PROACTIVITY_ENABLED !== "enabled"
    ) {
      return;
    }
    const queue = environment.WEEKLY_DELIVERY_QUEUE;
    if (queue === undefined || environment.WEEKLY_DELIVERY_WORKFLOW === undefined) {
      return yield* new InsightUnavailable();
    }
    const work = yield* discoverDeliveryWork({
      db: environment.DB,
      now: now.epochMilliseconds,
      weeklyEnabled: environment.WEEKLY_SUMMARY_ENABLED === "enabled",
      proactivityEnabled: environment.PROACTIVITY_ENABLED === "enabled",
    });
    yield* attemptIndependent(
      work.map((item) => publishProactivityItem({ queue, db: environment.DB, item, now }))
    );
  });

/** Maintenance discovers only bounded identities. All generation and delivery run in the User coordinator; failures never skip unrelated cleanup or publication. */
export const advanceProactivityWork = (
  environment: ProactivityBackgroundEnvironment
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* attemptIndependent([
      ...(evidenceRetentionDue(now)
        ? [
            sweepInsightChannelEvidence({ db: environment.DB, now: now.epochMilliseconds }),
            sweepProactivityChannelEvidence({ db: environment.DB, now: now.epochMilliseconds }),
          ]
        : []),
      expireWeeklyQuestions({ db: environment.DB, now: now.epochMilliseconds }),
      expireDeliveryWork({ db: environment.DB, now: now.epochMilliseconds }),
      generateDueWeeklyWork({ environment, now }),
      generateDueProactivity({ environment, now }),
      publishProactivityWork({ environment, now }),
    ]);
  }).pipe(
    Effect.mapError(() => new InsightUnavailable()),
    Effect.withSpan("insights.weekly.dispatch")
  );

/** Queue contents are untrusted hints; Workflow identity deduplication never replaces User-owned guards. */
export const startProactivityWorkflow = (
  input: Readonly<{
    body: unknown;
    workflow: Option.Option<Workflow<ProactivityDeliveryWork>>;
    coordinator: Coordinator;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.workflow)) return yield* new InsightUnavailable();
    const workflow = input.workflow.value;
    const work = yield* Schema.decodeUnknownEffect(ProactivityDeliveryWork)(input.body);
    const id = yield* proactivityWorkflowId(work);
    const params = yield* sanitizeWorkTrace(work);
    const created = yield* Effect.exit(Effect.tryPromise(() => workflow.create({ id, params })));
    if (created._tag === "Failure") {
      const instance = yield* Effect.tryPromise(() => workflow.get(id));
      const status = yield* Effect.tryPromise(() => instance.status());
      if (
        status.status === "errored" ||
        status.status === "terminated" ||
        status.status === "complete"
      ) {
        const recovery = yield* runActivity({
          coordinator: input.coordinator,
          work: { kind: "proactivity-recover", version: 1, userId: work.userId, work },
        });
        if (recovery._tag === "RecoveryAdmitted") {
          yield* Effect.tryPromise(() => instance.restart());
        }
      }
    }
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Per-message acknowledgment follows durable Workflow handoff; failures remain eligible for bounded native retries. */
export const receiveProactivityWork = (
  input: Readonly<{
    messages: ReadonlyArray<Pick<Message<unknown>, "body" | "ack" | "retry">>;
    workflow: Option.Option<Workflow<ProactivityDeliveryWork>>;
    users: Option.Option<Coordinator>;
  }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const message of input.messages) {
      const coordinator = input.users;
      const outcome = yield* Effect.exit(
        Option.isNone(coordinator)
          ? Effect.fail(new InsightUnavailable())
          : startProactivityWorkflow({
              body: message.body,
              workflow: input.workflow,
              coordinator: coordinator.value,
            })
      );
      if (outcome._tag === "Success") message.ack();
      else message.retry({ delaySeconds: 60 });
    }
  });

const runProactivityWorkflow = ({
  coordinator,
  payload,
  step,
  environment,
}: Readonly<{
  environment: unknown;
  coordinator: Coordinator;
  payload: ProactivityDeliveryWork;
  step: WorkflowStep;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* Schema.decodeEffect(ProactivityDeliveryWork)(payload);
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      for (let wake = 0; wake < 4; wake += 1) {
        const result = yield* Effect.tryPromise(() =>
          step.do(
            `weekly-delivery-${wake}`,
            {
              retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
              timeout: "40 seconds",
            },
            () => run(runActivity({ coordinator, work }))
          )
        );
        if (result._tag !== "Deferred") return;
        yield* Effect.tryPromise(() =>
          step.sleepUntil(`weekly-window-${wake}`, result.nextEligibleAtMs)
        );
      }
      return yield* new InsightUnavailable();
    }).pipe(
      observeWorkerExecution({
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.proactivityDelivery",
        parent: workTraceParent(payload),
      })
    )
  );

/** Native Workflow persists identities and wake-up instants only; every wake rechecks live User authority. */
export class ProactivityDeliveryWorkflow extends WorkflowEntrypoint<
  Pick<UserStoreBindings, "USER_STORE">,
  ProactivityDeliveryWork
> {
  run(event: WorkflowEvent<ProactivityDeliveryWork>, step: WorkflowStep): Promise<void> {
    const coordinator = this.env.USER_STORE;
    return observeWorkerPromise(
      () =>
        runProactivityWorkflow({
          coordinator,
          payload: event.payload,
          step,
          environment: this.env,
        }),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.proactivityDelivery",
        parent: workTraceParent(event.payload),
      }
    );
  }
}

export const makeInsightsErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

const localSender = Effect.fn(function* (env: NativeReminderEnvironment) {
  const config = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
    env.PROACTIVITY_TEMPLATE_JSON ?? ""
  );
  return makeProactivityTemplateSender({
    configuration: config,
    outboundHttp: yield* nativeOutbound(env),
  });
});
const weeklySummarySender = Effect.fn(function* (env: NativeReminderEnvironment) {
  const configuration = yield* Schema.decodeEffect(
    Schema.fromJsonString(InsightTemplateConfiguration)
  )(env.WEEKLY_SUMMARY_TEMPLATE_JSON ?? "");
  return makeInsightTemplateSender({ configuration, outboundHttp: yield* nativeOutbound(env) });
});
const recoverWeekly = Effect.fn(function* (
  environment: NativeReminderEnvironment,
  storage: DurableObjectStorage
) {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.scoped(
    Effect.flatMap(weeklyQuestionSender(environment), (sender) =>
      prepareGovernorQuestion(sender, now).pipe(withStoreCapacity("required"))
    )
  );
  const questions = yield* offerWeeklyQuestions(now, storage, environment);
  const summaries = yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqliteClient;
      yield* sql`DELETE FROM weekly_summary_reports WHERE id IN(SELECT id FROM weekly_summary_reports WHERE expires_ms<=${now} ORDER BY expires_ms LIMIT 8)`;
      yield* materializeWeekly(now, yield* weeklySummarySender(environment));
      return yield* offerDeliveries(environment, now, true);
    })
  );
  yield* repairWeekly(now, storage);
  return {
    attempted: summaries.attempted + questions.attempted,
    failed: summaries.failed + questions.failed,
  };
});
const weeklyQuestionSender = Effect.fn(function* (env: NativeReminderEnvironment) {
  const configuration = yield* Schema.decodeEffect(
    Schema.fromJsonString(WeeklyQuestionTemplateConfiguration)
  )(env.WEEKLY_QUESTION_TEMPLATE_JSON ?? "");
  return makeWeeklyQuestionSender({ configuration, outboundHttp: yield* nativeOutbound(env) });
});
export const observedReminderChoice = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  environment: NativeReminderEnvironment,
  storage: DurableObjectStorage
) {
  yield* recordWeeklyReply(event).pipe(withStoreCapacity("required"));
  yield* recordReminderReply(event).pipe(withStoreCapacity("required"));
  if (!activeChoiceText(event.text)) {
    return Option.none<Response>();
  }
  const negative =
    /^(?:no|desactivar)$|^(?:weekly|p:(?:manual-entry-reminder|budget-threshold|new-recurring-series)):[0-9a-f-]{36}:(?:decline|revoke)$/iu.test(
      event.text.trim()
    );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const senders = {
        category:
          !negative && environment.PROACTIVITY_ENABLED === "enabled"
            ? yield* Effect.option(localSender(environment))
            : Option.none(),
        weekly:
          !negative && environment.WEEKLY_SUMMARY_ENABLED === "enabled"
            ? yield* Effect.option(weeklyQuestionSender(environment))
            : Option.none(),
      };
      return yield* handleChoice(event, senders, storage).pipe(
        withStoreCapacity(negative ? "required" : "growth")
      );
    })
  );
});
export const repairLocalReminderAlarm = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  flags: { category: boolean; weekly: boolean }
) {
  const category = yield* repairReminder(current, storage, flags.category);
  const weekly = flags.weekly ? yield* repairWeekly(current, storage) : false;
  return category || weekly;
});
export const recoverLocalReminders = Effect.fn(function* (
  environment: NativeReminderEnvironment,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const empty = { attempted: 0, failed: 0 };
  const weekly =
    environment.WEEKLY_SUMMARY_ENABLED === "enabled"
      ? yield* recoverWeekly(environment, storage).pipe(Effect.result)
      : undefined;
  const category =
    environment.PROACTIVITY_ENABLED !== "enabled"
      ? empty
      : yield* Effect.scoped(
          Effect.flatMap(localSender(environment), (sender) =>
            Effect.gen(function* () {
              const offer = yield* dispatchDisclosure(
                environment,
                { category: sender },
                storage
              ).pipe(Effect.result);
              const recovered = yield* processReminder({ environment, storage, owns, sender });
              return { ...recovered, failed: recovered.failed + Number(offer._tag === "Failure") };
            })
          )
        );
  return {
    attempted: category.attempted + (weekly?._tag === "Success" ? weekly.success.attempted : 0),
    failed:
      category.failed +
      (weekly?._tag === "Success" ? weekly.success.failed : Number(weekly?._tag === "Failure")),
  };
});
const recoverDelivery = Effect.fn(function* (
  work: Extract<ProactivityActivity, { kind: "proactivity-recover" }>,
  environment: NativeReminderEnvironment
) {
  const job = work.work;
  if (
    job.userId !== work.userId ||
    (job.kind === "proactivity-delivery"
      ? environment.PROACTIVITY_ENABLED
      : environment.WEEKLY_SUMMARY_ENABLED) !== "enabled"
  ) {
    return Response.json({ _tag: "Done" });
  }
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;
  const rows =
    job.kind === "weekly-question"
      ? yield* sql`UPDATE reminder_disclosures SET restarts=restarts+1 WHERE user_id=${work.userId} AND id=${job.id} AND kind='weekly-summary' AND state='ready' AND expires_ms>${now} AND restarts<3 RETURNING id`
      : yield* sql`UPDATE reminder_deliveries SET restarts=restarts+1 WHERE user_id=${work.userId} AND id=${job.kind === "weekly-summary" ? job.insightEventId : job.id} AND state='ready' AND deadline_ms>${now} AND restarts<3 AND EXISTS(SELECT 1 FROM proactive_grants g WHERE g.id=grant_id AND (g.kind='weekly-summary')=${Number(job.kind === "weekly-summary")} AND g.revoked_at_ms IS NULL) RETURNING id`;
  return Response.json({ _tag: rows.length === 1 ? "RecoveryAdmitted" : "Done" });
});
const weeklyActivity = Effect.fn(function* (
  work: Extract<ProactivityDeliveryWork, { kind: "weekly-summary" | "weekly-question" }>,
  environment: NativeReminderEnvironment,
  storage: DurableObjectStorage
) {
  if (work.kind === "weekly-question") {
    yield* Effect.scoped(
      Effect.flatMap(weeklyQuestionSender(environment), (sender) =>
        dispatchDisclosure(environment, { weekly: sender, id: work.id }, storage)
      )
    );
    return Response.json({ _tag: "Done" });
  }
  return Response.json(
    yield* Effect.scoped(
      Effect.flatMap(weeklySummarySender(environment), (sender) =>
        deliverReminder(
          environment,
          { userId: work.userId, id: work.insightEventId },
          { weekly: sender }
        )
      )
    )
  );
});
export const nativeReminderActivity = Effect.fn(function* (
  request: Request,
  environment: NativeReminderEnvironment,
  { owns, storage }: { owns: (id: string) => boolean; storage: DurableObjectStorage }
) {
  const work = yield* Schema.decodeUnknownEffect(ProactivityActivity)(
    yield* Effect.tryPromise(() => request.json())
  );
  if (!owns(work.userId)) return Response.json({ _tag: "Done" });
  if (work.kind === "weekly-question" || work.kind === "weekly-summary")
    {return environment.WEEKLY_SUMMARY_ENABLED === "enabled"
      ? yield* weeklyActivity(work, environment, storage)
      : Response.json({ _tag: "Done" });}
  if (work.kind === "proactivity-recover") return yield* recoverDelivery(work, environment);
  if (work.kind !== "proactivity-delivery" || environment.PROACTIVITY_ENABLED !== "enabled") {
    return Response.json({ _tag: "Done" });
  }
  return Response.json(
    yield* Effect.scoped(
      Effect.flatMap(localSender(environment), (sender) =>
        deliverReminder(environment, work, { category: sender })
      )
    )
  );
});
