import { proactivityWorkflowId } from "./internal/proactivity-workflow";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema, type Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
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
import { captureWorkflowFailure } from "../runtime/operational-health/operations";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry/operations";
import { executeWeeklyActivity, weeklyThresholds } from "./internal/weekly-execution";
import { deliverProactivity, generateProactivity } from "./internal/proactivity-execution";
import { discoverProactivityUsers, noteProactivityEvaluation } from "./internal/proactivity-work";
import { discoverDueWeeklySchedules, noteWeeklyScheduleEvaluation } from "./operations";
import {
  type DueWeeklySchedule,
  InsightUnavailable,
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
  environment: ProactivityEnvironment
): Effect.Effect<OutboundHttpService, InsightUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    if (environment.KAPSO_API_KEY === undefined || environment.KAPSO_API_KEY.length === 0) {
      return yield* new InsightUnavailable();
    }
    const services = yield* Layer.build(FetchHttpClient.layer);
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
    const summaryConfiguration = yield* Schema.decodeEffect(
      Schema.fromJsonString(InsightTemplateConfiguration)
    )(environment.WEEKLY_SUMMARY_TEMPLATE_JSON ?? "");
    const questionConfiguration = yield* Schema.decodeEffect(
      Schema.fromJsonString(WeeklyQuestionTemplateConfiguration)
    )(environment.WEEKLY_QUESTION_TEMPLATE_JSON ?? "");
    const outboundHttp = yield* nativeOutbound(environment);
    return yield* executeWeeklyActivity({
      ...input,
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
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ProactivityActivity))(input.work);
    const response = yield* Effect.tryPromise((signal) =>
      input.coordinator.getByName(input.work.userId).fetch("https://coordinator/proactivity-work", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    // Discovery-attempt metadata rotates even when the User coordinator or resource admission is unavailable.
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
    if (input.environment.WEEKLY_SUMMARY_ENABLED !== "enabled") return;
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
    yield* Effect.tryPromise(() => input.queue.send(input.item, { contentType: "json" }));
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
      sweepInsightChannelEvidence({ db: environment.DB, now: now.epochMilliseconds }),
      sweepProactivityChannelEvidence({ db: environment.DB, now: now.epochMilliseconds }),
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
    const created = yield* Effect.exit(
      Effect.tryPromise(() => workflow.create({ id, params: work }))
    );
    if (created._tag === "Failure") {
      const instance = yield* Effect.tryPromise(() => workflow.get(id));
      const status = yield* Effect.tryPromise(() => instance.status());
      if (
        status.status === "errored" ||
        status.status === "terminated" ||
        status.status === "complete"
      ) {
        // Domain one-shot claims survive Workflow restart: started sends reconcile, never resend.
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
    coordinator: Coordinator;
  }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const message of input.messages) {
      const outcome = yield* Effect.exit(
        startProactivityWorkflow({
          body: message.body,
          workflow: input.workflow,
          coordinator: input.coordinator,
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
}: Readonly<{
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
    })
  );

/** Native Workflow persists identities and wake-up instants only; every wake rechecks live User authority. */
export class ProactivityDeliveryWorkflow extends WorkflowEntrypoint<
  ProactivityBackgroundEnvironment,
  ProactivityDeliveryWork
> {
  run(event: WorkflowEvent<ProactivityDeliveryWork>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      db: this.env.DB,
      work: observeWorkerPromise(
        () =>
          runProactivityWorkflow({
            coordinator: this.env.USER_TRANSACTION_COORDINATOR,
            payload: event.payload,
            step,
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.proactivityDelivery",
        }
      ),
    });
  }
}
