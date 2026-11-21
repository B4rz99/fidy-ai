import {
  discoverCategoryOpportunity,
  materializeCategoryOpportunity,
} from "./internal/native-category-opportunity";
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
import { OutboundHttpLive } from "../outbound-http/runtime";
import { proactivityWorkflowId } from "./internal/proactivity-workflow";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  type Scope,
} from "effect";
import {
  InsightTemplateConfiguration,
  WeeklyQuestionTemplateConfiguration,
} from "../../src/shell/channels/whatsapp/contract";
import { TemplateSenders } from "../../src/shell/channels/whatsapp/runtime";
import { OutboundHttp } from "../../src/shell/outbound-http/operations";
import {
  captureTraceHeaders,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  observeWorkerPromise,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  InsightUnavailable,
  type NativeReminderEnvironment,
  ProactivityActivity,
  ProactivityActivityResult,
  ProactivityDeliveryWork,
} from "./contract";

const ActivityResult = Data.taggedEnum<ProactivityActivityResult>();

const templateSenders = (
  environment: Partial<Readonly<{ KAPSO_API_KEY: string }>>
): Effect.Effect<TemplateSenders["Service"], InsightUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    if (environment.KAPSO_API_KEY === undefined || environment.KAPSO_API_KEY.length === 0) {
      return yield* new InsightUnavailable({ cause: Option.none() });
    }

    const services = yield* Layer.build(
      TemplateSenders.layer.pipe(
        Layer.provide(OutboundHttp.kapso(Redacted.make(environment.KAPSO_API_KEY))),
        Layer.provide(OutboundHttpLive)
      )
    );

    return Context.get(services, TemplateSenders);
  });

type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;

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

    if (!response.ok) return yield* new InsightUnavailable({ cause: Option.none() });

    return yield* Schema.decodeUnknownEffect(ProactivityActivityResult)(
      yield* Effect.tryPromise(() => response.json())
    );
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => new InsightUnavailable({ cause: Option.some(cause) }))
  );

export const startProactivityWorkflow = (
  input: Readonly<{
    body: unknown;
    workflow: Option.Option<Workflow<ProactivityDeliveryWork>>;
    coordinator: Coordinator;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.workflow)) {
      return yield* new InsightUnavailable({ cause: Option.none() });
    }

    const workflow = input.workflow.value;
    const work = yield* Schema.decodeUnknownEffect(ProactivityDeliveryWork)(input.body);
    const id = yield* proactivityWorkflowId(work);
    const params = yield* sanitizeWorkTrace(work);
    const created = yield* Effect.exit(Effect.tryPromise(() => workflow.create({ id, params })));

    if (Exit.isFailure(created)) {
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

        if (Predicate.isTagged(recovery, "RecoveryAdmitted")) {
          yield* Effect.tryPromise(() => instance.restart());
        }
      }
    }
  }).pipe(Effect.mapError((cause) => new InsightUnavailable({ cause: Option.some(cause) })));

export const receiveProactivityWork = (
  input: Readonly<{
    messages: ReadonlyArray<Pick<Message<unknown>, "body" | "ack" | "retry">>;
    workflow: Option.Option<Workflow<ProactivityDeliveryWork>>;
    users: Option.Option<Coordinator>;
  }>
): Effect.Effect<void> =>
  Effect.forEach(
    input.messages,
    Effect.fnUntraced(function* (message) {
      const coordinator = input.users;

      const outcome = yield* Effect.exit(
        Option.isNone(coordinator)
          ? Effect.fail(new InsightUnavailable({ cause: Option.none() }))
          : startProactivityWorkflow({
              body: message.body,
              workflow: input.workflow,
              coordinator: coordinator.value,
            })
      );

      if (Exit.isSuccess(outcome)) message.ack();
      else message.retry({ delaySeconds: 60 });
    }),
    { discard: true }
  );

const deliveryWake = Effect.fnUntraced(function* (
  step: WorkflowStep,
  wake: number,
  deliver: () => Promise<ProactivityActivityResult>
) {
  const result = yield* Effect.tryPromise(() =>
    step.do(
      `weekly-delivery-${wake}`,
      {
        retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
        timeout: "40 seconds",
      },
      deliver
    )
  );

  if (!Predicate.isTagged(result, "Deferred")) return true;
  yield* Effect.tryPromise(() => step.sleepUntil(`weekly-window-${wake}`, result.nextEligibleAtMs));

  return false;
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
  workflowRuntime.runPromise(
    Effect.gen(function* () {
      const work = yield* Schema.decodeEffect(ProactivityDeliveryWork)(payload);
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);

      const settled = yield* Effect.reduce(
        [0, 1, 2, 3],
        () => false,
        (done, wake) =>
          done
            ? Effect.succeed(true)
            : deliveryWake(step, wake, () => run(runActivity({ coordinator, work })))
      );

      if (settled) return;

      return yield* new InsightUnavailable({ cause: Option.none() });
    }).pipe(
      observeWorkerExecution({
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.proactivityDelivery",
        parent: workTraceParent(payload),
      })
    )
  );

const workflowRuntime = ManagedRuntime.make(Layer.empty);

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

const localSender = Effect.fn(function* (env: NativeReminderEnvironment) {
  const config = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
    env.PROACTIVITY_TEMPLATE_JSON ?? ""
  );

  return (yield* templateSenders(env)).proactivity(config);
});

const weeklySummarySender = Effect.fn(function* (env: NativeReminderEnvironment) {
  const configuration = yield* Schema.decodeEffect(
    Schema.fromJsonString(InsightTemplateConfiguration)
  )(env.WEEKLY_SUMMARY_TEMPLATE_JSON ?? "");

  return (yield* templateSenders(env)).insight(configuration);
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

  return (yield* templateSenders(env)).weeklyQuestion(configuration);
});

export const observedReminderChoice = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  environment: NativeReminderEnvironment,
  storage: DurableObjectStorage
) {
  yield* recordWeeklyReply(event).pipe(withStoreCapacity("required"));
  yield* recordReminderReply(event).pipe(withStoreCapacity("required"));

  if (!activeChoiceText(event.text)) {
    if (environment.PROACTIVITY_ENABLED === "enabled") {
      yield* discoverCategoryOpportunity(event, storage).pipe(
        withStoreCapacity("growth"),
        Effect.result
      );
    }

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
              yield* materializeCategoryOpportunity(sender, storage).pipe(
                withStoreCapacity("growth")
              );

              const offer = yield* dispatchDisclosure(
                environment,
                { category: sender },
                storage
              ).pipe(Effect.result);

              const recovered = yield* processReminder({ environment, storage, owns, sender });

              return { ...recovered, failed: recovered.failed + Number(Result.isFailure(offer)) };
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
    return Response.json(ActivityResult.Done());
  }

  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const rows =
    job.kind === "weekly-question"
      ? yield* sql`UPDATE reminder_disclosures SET restarts=restarts+1 WHERE user_id=${work.userId} AND id=${job.id} AND kind='weekly-summary' AND state='ready' AND expires_ms>${now} AND restarts<3 RETURNING id`
      : yield* sql`UPDATE reminder_deliveries SET restarts=restarts+1 WHERE user_id=${work.userId} AND id=${job.kind === "weekly-summary" ? job.insightEventId : job.id} AND state='ready' AND deadline_ms>${now} AND restarts<3 AND EXISTS(SELECT 1 FROM proactive_grants g WHERE g.id=grant_id AND (g.kind='weekly-summary')=${Number(job.kind === "weekly-summary")} AND g.revoked_at_ms IS NULL) RETURNING id`;

  return Response.json(
    rows.length === 1 ? ActivityResult.RecoveryAdmitted() : ActivityResult.Done()
  );
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

    return Response.json(ActivityResult.Done());
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

  if (!owns(work.userId)) return Response.json(ActivityResult.Done());

  if (work.kind === "weekly-question" || work.kind === "weekly-summary") {
    return environment.WEEKLY_SUMMARY_ENABLED === "enabled"
      ? yield* weeklyActivity(work, environment, storage)
      : Response.json(ActivityResult.Done());
  }

  if (work.kind === "proactivity-recover") return yield* recoverDelivery(work, environment);

  if (work.kind !== "proactivity-delivery" || environment.PROACTIVITY_ENABLED !== "enabled") {
    return Response.json(ActivityResult.Done());
  }

  return Response.json(
    yield* Effect.scoped(
      Effect.flatMap(localSender(environment), (sender) =>
        deliverReminder(environment, work, { category: sender })
      )
    )
  );
});
