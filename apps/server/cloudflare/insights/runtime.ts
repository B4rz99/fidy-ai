import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { type UserId } from "../../src/core/identity/contract";
import {
  InsightTemplateConfiguration,
  WeeklyQuestionTemplateConfiguration,
} from "../../src/shell/channels/whatsapp/contract";
import {
  makeInsightTemplateSender,
  makeWeeklyQuestionSender,
} from "../../src/shell/channels/whatsapp/runtime";
import { makeKapsoOutboundHttp } from "../../src/shell/outbound-http/operations";
import { executeWeeklyActivity, weeklyThresholds } from "./internal/weekly-execution";
import { discoverDueWeeklySchedules, noteWeeklyScheduleEvaluation } from "./operations";
import {
  type DueWeeklySchedule,
  InsightUnavailable,
  WeeklyActivity,
  WeeklyActivityResult,
  WeeklyDeliveryWork,
  type WeeklyEnvironment,
} from "./contract";
import {
  discoverDeliveryWork,
  expireDeliveryWork,
  markOffered,
  recoverDeliveryWork,
} from "./internal/weekly-work";
import { expireWeeklyQuestions, sweepInsightChannelEvidence } from "../whatsapp/operations";

/** Construct approved senders only at the native composition publication. */
export const executeWeeklyWork = (
  input: Readonly<{
    environment: WeeklyEnvironment;
    userId: UserId;
    work: WeeklyActivity;
    now: DateTime.Utc;
  }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment = input.environment;
      if (input.work.kind === "weekly-recover") {
        const admitted = yield* recoverDeliveryWork({
          db: environment.DB,
          userId: input.userId,
          work: input.work.work,
          now: input.now.epochMilliseconds,
        });
        return admitted ? ({ _tag: "RecoveryAdmitted" } as const) : ({ _tag: "Done" } as const);
      }
      if (
        environment.WEEKLY_SUMMARY_ENABLED !== "enabled" ||
        environment.KAPSO_API_KEY === undefined ||
        environment.KAPSO_API_KEY.length === 0
      ) {
        return yield* new InsightUnavailable();
      }
      yield* weeklyThresholds(environment);
      const summaryConfiguration = yield* Schema.decodeEffect(
        Schema.fromJsonString(InsightTemplateConfiguration)
      )(environment.WEEKLY_SUMMARY_TEMPLATE_JSON ?? "");
      const questionConfiguration = yield* Schema.decodeEffect(
        Schema.fromJsonString(WeeklyQuestionTemplateConfiguration)
      )(environment.WEEKLY_QUESTION_TEMPLATE_JSON ?? "");
      const services = yield* Layer.build(FetchHttpClient.layer);
      const outboundHttp = makeKapsoOutboundHttp({
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        httpClient: Context.get(services, HttpClient.HttpClient),
      });
      return yield* executeWeeklyActivity({
        ...input,
        work: input.work,
        db: environment.DB,
        senders: {
          summary: makeInsightTemplateSender({ configuration: summaryConfiguration, outboundHttp }),
          question: makeWeeklyQuestionSender({
            configuration: questionConfiguration,
            outboundHttp,
          }),
        },
      });
    })
  ).pipe(Effect.mapError(() => new InsightUnavailable()));

type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
type WeeklyBackgroundEnvironment = WeeklyEnvironment &
  Readonly<{ USER_TRANSACTION_COORDINATOR: Coordinator }> &
  Partial<
    Readonly<{
      WEEKLY_DELIVERY_QUEUE: Pick<Queue<WeeklyDeliveryWork>, "send">;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<WeeklyDeliveryWork>;
    }>
  >;

const runActivity = (
  input: Readonly<{ coordinator: Coordinator; work: WeeklyActivity }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(WeeklyActivity))(input.work);
    const response = yield* Effect.tryPromise((signal) =>
      input.coordinator.getByName(input.work.userId).fetch("https://coordinator/weekly-work", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      })
    );
    if (!response.ok) return yield* new InsightUnavailable();
    return yield* Schema.decodeUnknownEffect(WeeklyActivityResult)(
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
    environment: WeeklyBackgroundEnvironment;
    now: DateTime.Utc;
    schedule: DueWeeklySchedule;
  }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
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
  input: Readonly<{ environment: WeeklyBackgroundEnvironment; now: DateTime.Utc }>
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
const publishWeeklyItem = (
  input: Readonly<{
    queue: NonNullable<WeeklyBackgroundEnvironment["WEEKLY_DELIVERY_QUEUE"]>;
    db: D1Database;
    item: WeeklyDeliveryWork;
    now: DateTime.Utc;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => input.queue.send(input.item, { contentType: "json" }));
    yield* markOffered({ db: input.db, work: input.item, now: input.now.epochMilliseconds });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
const publishWeeklyWork = (
  input: Readonly<{ environment: WeeklyBackgroundEnvironment; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const { environment, now } = input;
    if (environment.WEEKLY_SUMMARY_ENABLED !== "enabled") return;
    const queue = environment.WEEKLY_DELIVERY_QUEUE;
    if (queue === undefined || environment.WEEKLY_DELIVERY_WORKFLOW === undefined) {
      return yield* new InsightUnavailable();
    }
    const work = yield* discoverDeliveryWork({ db: environment.DB, now: now.epochMilliseconds });
    yield* attemptIndependent(
      work.map((item) => publishWeeklyItem({ queue, db: environment.DB, item, now }))
    );
  });

/** Maintenance discovers only bounded identities. All generation and delivery run in the User coordinator; failures never skip unrelated cleanup or publication. */
export const advanceWeeklyWork = (
  environment: WeeklyBackgroundEnvironment
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* attemptIndependent([
      sweepInsightChannelEvidence({ db: environment.DB, now: now.epochMilliseconds }),
      expireWeeklyQuestions({ db: environment.DB, now: now.epochMilliseconds }),
      expireDeliveryWork({ db: environment.DB, now: now.epochMilliseconds }),
      generateDueWeeklyWork({ environment, now }),
      publishWeeklyWork({ environment, now }),
    ]);
  }).pipe(
    Effect.mapError(() => new InsightUnavailable()),
    Effect.withSpan("insights.weekly.dispatch")
  );

/** Queue contents are untrusted hints; Workflow identity deduplication never replaces User-owned guards. */
export const startWeeklyWorkflow = (
  input: Readonly<{
    body: unknown;
    workflow: Option.Option<Workflow<WeeklyDeliveryWork>>;
    coordinator: Coordinator;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.workflow)) return yield* new InsightUnavailable();
    const workflow = input.workflow.value;
    const work = yield* Schema.decodeUnknownEffect(WeeklyDeliveryWork)(input.body);
    const id = `weekly-${work.userId}-${work.kind}-${work.kind === "weekly-summary" ? work.insightEventId : work.id}`;
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
          work: { kind: "weekly-recover", version: 1, userId: work.userId, work },
        });
        if (recovery._tag === "RecoveryAdmitted") {
          yield* Effect.tryPromise(() => instance.restart());
        }
      }
    }
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Per-message acknowledgment follows durable Workflow handoff; failures remain eligible for bounded native retries. */
export const receiveWeeklyWork = (
  input: Readonly<{
    messages: ReadonlyArray<Pick<Message<unknown>, "body" | "ack" | "retry">>;
    workflow: Option.Option<Workflow<WeeklyDeliveryWork>>;
    coordinator: Coordinator;
  }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const message of input.messages) {
      const outcome = yield* Effect.exit(
        startWeeklyWorkflow({
          body: message.body,
          workflow: input.workflow,
          coordinator: input.coordinator,
        })
      );
      if (outcome._tag === "Success") message.ack();
      else message.retry({ delaySeconds: 60 });
    }
  });

/** Native Workflow persists identities and wake-up instants only; every wake rechecks live User authority. */
export class WeeklyDeliveryWorkflow extends WorkflowEntrypoint<
  WeeklyBackgroundEnvironment,
  WeeklyDeliveryWork
> {
  run(event: WorkflowEvent<WeeklyDeliveryWork>, step: WorkflowStep): Promise<void> {
    const coordinator = this.env.USER_TRANSACTION_COORDINATOR;
    return Effect.runPromise(
      Effect.gen(function* () {
        const work = yield* Schema.decodeEffect(WeeklyDeliveryWork)(event.payload);
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
  }
}
