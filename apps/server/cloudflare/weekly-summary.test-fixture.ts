import { DateTime, Effect, Option, Schema } from "effect";
import {
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepContext,
  type WorkflowStepRollbackOptions,
} from "cloudflare:workers";
import { WeeklyDeliveryWorkflow, advanceWeeklyWork, receiveWeeklyWork } from "./insights/runtime";
import { DisclosureSnapshot } from "../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../src/core/identity/contract";
import { currentDisclosureFor } from "../src/shell/consent/operations";
import {
  createWeeklyConsentOffer,
  recordConsentRevocation,
  recordWeeklyConsentDisclosure,
} from "./consent/operations";
import {
  findWeeklySchedule,
  generateInsight,
  recordWeeklySummaryDecision,
} from "./insights/operations";
import {
  type InsightUnavailable,
  type WeeklyEnvironment,
  type WeeklyScheduleSnapshot,
} from "./insights/contract";
import { UserTransactionCoordinator } from "./transactions/runtime";
import { type InsightEventId, InsightGenerationInput } from "../src/core/insights/contract";
import { categoryIds } from "../src/core/categories/contract";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

export type WeeklySummaryCoordinator = Pick<UserTransactionCoordinator, "fetch">;
/** Compose the real coordinator with deliberately unavailable inference. */
export const makeWeeklySummaryCoordinator = ({
  environment,
  userId,
}: Readonly<{ environment: WeeklyEnvironment; userId: UserId }>): WeeklySummaryCoordinator =>
  new UserTransactionCoordinator(
    { id: { name: userId }, storage: { setAlarm: () => Promise.resolve() } },
    {
      ...environment,
      AI: { run: () => Promise.reject(new Error("Inference unavailable")) },
      HOSTED_AI_MODEL: "unavailable-model",
    }
  );

/** Broad native WeeklySummary integration harness; seeds qualified Users, never substitutes owner persistence. */
export const weeklySummaryTestDatabases = isolatedTestDatabases();
export const weeklySummaryTestUser = UserId.make("10000000-0000-4000-8000-000000000051");
export const weeklySummaryOtherUser = UserId.make("10000000-0000-4000-8000-000000000052");
export const weeklySummaryTestCaller = Schema.decodeSync(WhatsAppCallerReference)({
  businessPortfolioId: "portfolio",
  businessScopedUserId: "CO.abcdef",
});
export const weeklySummaryTestNow = DateTime.makeUnsafe("2026-08-09T12:00:00Z");
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
export const weeklySummaryDatabaseAt = (now: DateTime.Utc): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* attempt(() => weeklySummaryTestDatabases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
    ).sort();
    yield* attempt(() =>
      installTestSchema({
        db,
        sources: names.map((name) => new URL(`./migrations/${name}`, import.meta.url)),
      })
    );
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(currentDisclosureFor()).pipe(Effect.orDie);
    for (const id of [weeklySummaryTestUser, weeklySummaryOtherUser]) {
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(id, now.epochMilliseconds)
          .run()
      );
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',?,?)"
          )
          .bind(id, id, json, 0, 0)
          .run()
      );
    }
    yield* attempt(() =>
      db
        .prepare(
          "INSERT INTO whatsapp_identities (user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
        )
        .bind(
          weeklySummaryTestUser,
          weeklySummaryTestCaller.businessPortfolioId,
          weeklySummaryTestCaller.businessScopedUserId,
          now.epochMilliseconds
        )
        .run()
    );
    return db;
  });

export const weeklySummaryTestDatabase: Effect.Effect<D1Database> =
  weeklySummaryDatabaseAt(weeklySummaryTestNow);

/** Native step adapter executes the real callback; no manufactured activity results or assertions. */
const executeWeeklyFixtureStep: WorkflowStep["do"] = <Result>(
  name: string,
  configurationOrCallback: WorkflowStepConfig | ((ctx: WorkflowStepContext) => Promise<Result>),
  third?:
    | ((ctx: WorkflowStepContext) => Promise<Result>)
    | WorkflowStepRollbackOptions<Result, never>
): Promise<Result> => {
  let callback = third;
  if (typeof configurationOrCallback === "function") callback = configurationOrCallback;
  if (typeof callback !== "function") {
    return Promise.reject(new Error("Missing Workflow step callback"));
  }
  return callback({ step: { name, count: 0 }, attempt: 1, config: {} });
};

export const makeExecutingWeeklyFixtureStep = (): WorkflowStep["do"] => executeWeeklyFixtureStep;

const weeklyWorkflowFixtureContext = {
  waitUntil: (_promise: Promise<unknown>): void => undefined,
  passThroughOnException: (): void => undefined,
  props: {},
  exports: {},
  abort: (): void => undefined,
  get tracing(): Tracing {
    throw new Error("Workflow fixture does not grant tracing authority");
  },
};

type WeeklyBackgroundFixtureEnvironment = Parameters<typeof advanceWeeklyWork>[0];
type WeeklyFixtureWork = Parameters<WeeklyDeliveryWorkflow["run"]>[0]["payload"];
/** Broad composition: Maintenance, durable Queue handoff, native Workflow and real User coordinator. */
export const weeklyWorkflowHarness = (
  input: Readonly<{
    environment: Omit<WeeklyBackgroundFixtureEnvironment, "USER_TRANSACTION_COORDINATOR">;
    userId: UserId;
    otherUserIds: ReadonlyArray<UserId>;
    unavailableUserIds: ReadonlyArray<UserId>;
  }>
): Readonly<{
  sweep: () => Effect.Effect<void, InsightUnavailable>;
  receive: (
    input: Omit<Parameters<typeof receiveWeeklyWork>[0], "coordinator">
  ) => Effect.Effect<void>;
  execute: (input: Readonly<{ work: WeeklyFixtureWork; step: WorkflowStep }>) => Promise<void>;
}> => {
  const coordinators = new Map<string, WeeklySummaryCoordinator>();
  for (const userId of [input.userId, ...input.otherUserIds]) {
    coordinators.set(
      userId,
      makeWeeklySummaryCoordinator({ environment: input.environment, userId })
    );
  }
  const environment: WeeklyBackgroundFixtureEnvironment = {
    ...input.environment,
    USER_TRANSACTION_COORDINATOR: {
      getByName: (name) => ({
        fetch: (request, init) => {
          const coordinator = coordinators.get(name);
          return coordinator === undefined ||
            input.unavailableUserIds.some((userId) => userId === name)
            ? Promise.resolve(new Response(null, { status: 503 }))
            : coordinator.fetch(request instanceof Request ? request : new Request(request, init));
        },
      }),
    },
  };
  const workflow = new WeeklyDeliveryWorkflow(weeklyWorkflowFixtureContext, environment);
  return {
    sweep: () => advanceWeeklyWork(environment),
    receive: (input) =>
      receiveWeeklyWork({ ...input, coordinator: environment.USER_TRANSACTION_COORDINATOR }),
    execute: ({ work, step }) =>
      workflow.run(
        {
          payload: work,
          instanceId: "weekly-fixture",
          workflowName: "weekly-fixture",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        },
        step
      ),
  };
};

/** Append an authenticated withdrawal using the real Consent publication and session guards. */
export const withdrawWeeklyFixtureConsent = (
  input: Readonly<{ db: D1Database; userId: UserId; now: number }>
): Effect.Effect<void> =>
  Effect.tryPromise(() => {
    const pairingId = "85000000-0000-4000-8000-000000000001";
    const sessionId = "85000000-0000-4000-8000-000000000002";
    const freshMs = 600_000;
    const hardMs = 7_776_000_000;
    const digestBytes = 32;
    return input.db.batch([
      input.db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'ABC-12345',zeroblob(32),?,'consumed',?,?)"
        )
        .bind(pairingId, input.userId, input.now, input.now + freshMs),
      input.db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,zeroblob(32),?,?,?,?)"
        )
        .bind(
          sessionId,
          pairingId,
          input.userId,
          input.now,
          input.now + freshMs,
          input.now + freshMs,
          input.now + hardMs
        ),
      recordConsentRevocation({
        db: input.db,
        subject: { id: sessionId, userId: input.userId, digest: new Uint8Array(digestBytes) },
        evidenceId: "85000000-0000-4000-8000-000000000003",
        current: input.now,
      }),
    ]);
  }).pipe(Effect.asVoid, Effect.orDie);

/** Set up actual authenticated explicit opt-in through the production owners. */
export const activateWeeklySummaryForUser = ({
  db,
  now,
  userId,
  caller,
}: Readonly<{
  db: D1Database;
  now: DateTime.Utc;
  userId: UserId;
  caller: WhatsAppCallerReference;
}>): Effect.Effect<WeeklyScheduleSnapshot> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId,
      caller,
      now,
    };
    const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: `weekly-disclosure-${userId}`,
    });
    yield* recordWeeklySummaryDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: `weekly-accept-${userId}`,
    });
    return Option.getOrThrow(yield* findWeeklySchedule(context));
  }).pipe(Effect.orDie);
export const activateWeeklySummary = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<WeeklyScheduleSnapshot> =>
  activateWeeklySummaryForUser({
    ...input,
    userId: weeklySummaryTestUser,
    caller: weeklySummaryTestCaller,
  });
/** Broad fixture input: actual effective transaction, not a replacement projection or report store. */
export const seedWeeklySummaryActivity = ({
  db,
  at,
}: Readonly<{ db: D1Database; at: string }>): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO transactions(id,user_id,amount,currency,category_id,direction,occurred_at,created_at,counterparty) VALUES (?,?, '10.25','COP',?,'outflow',?,?,NULL)"
      )
      .bind(
        "20000000-0000-4000-8000-000000000001",
        weeklySummaryTestUser,
        categoryIds.mercado,
        at,
        at
      )
      .run()
  ).pipe(Effect.asVoid, Effect.orDie);

/** Broad external-evidence fixture: another User reports the same opaque provider id for their own event. */
export const seedForeignProviderEvidence = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeEffect(Schema.toCodecJson(InsightGenerationInput))({
      kind: "manual-entry-reminder",
      scheduleId: "30000000-0000-4000-8000-000000000001",
      scheduleVersion: 1,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      scheduledAt: DateTime.formatIso(weeklySummaryTestNow),
      moneyGroups: [],
    });
    const event = Option.getOrThrow(
      yield* generateInsight({ db, userId: weeklySummaryOtherUser, input })
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO insight_delivery_attempts(id,user_id,insight_event_id,sent_at,channel,provider,provider_message_id) VALUES(?,?,?,?,'whatsapp','kapso','wamid.proactive')"
        )
        .bind(
          "30000000-0000-4000-8000-000000000002",
          weeklySummaryOtherUser,
          event.id,
          DateTime.formatIso(weeklySummaryTestNow)
        )
        .run()
    );
  }).pipe(Effect.orDie);

/** Broad fixture attention state; production mutations remain in the Insights owner. */
export const setWeeklySummaryAttention = (
  input: Readonly<{ db: D1Database; id: InsightEventId; state: "read" | "dismissed" }>
): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE insight_events SET lifecycle_state=? WHERE user_id=? AND id=?")
      .bind(input.state, weeklySummaryTestUser, input.id)
      .run()
  ).pipe(Effect.asVoid, Effect.orDie);
