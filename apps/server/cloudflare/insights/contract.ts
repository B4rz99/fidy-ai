import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { UserStoreBindings } from "../directory/contract";
import { Context, Data, Effect, Option, Schema } from "effect";
import {
  InsightEventId,
  ProactivityThresholds,
  ScheduleId,
} from "../../src/core/insights/contract";
import { UserId } from "../../src/core/identity/contract";
import { type TranscriptText } from "../../src/core/agent/contract";

export const WeeklySummaryWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("weekly-summary"),
  version: Schema.Literal(1),
  userId: UserId,
  insightEventId: InsightEventId,
});

export type WeeklySummaryWork = typeof WeeklySummaryWork.Type;

export const WeeklyQuestionWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("weekly-question"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});

export type WeeklyQuestionWork = typeof WeeklyQuestionWork.Type;

export const CategoryDeliveryWork = Schema.Struct({
  owner: Schema.optionalKey(Schema.Literal("user")),
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("proactivity-delivery"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});

export type CategoryDeliveryWork = typeof CategoryDeliveryWork.Type;

export const ProactivityDeliveryWork = Schema.Union([
  WeeklySummaryWork,
  WeeklyQuestionWork,
  CategoryDeliveryWork,
]);

export type ProactivityDeliveryWork = typeof ProactivityDeliveryWork.Type;

export const ProactivityWorkflowId = Schema.Union([
  Schema.TemplateLiteral([
    "weekly-",
    UserId,
    "-",
    Schema.Union([WeeklySummaryWork.fields.kind, WeeklyQuestionWork.fields.kind]),
    "-",
    WeeklyQuestionWork.fields.id,
  ]),
  Schema.TemplateLiteral(["proactivity-", UserId, "-", CategoryDeliveryWork.fields.id]),
]);

export const ProactivityWorkObservation = Schema.Struct({
  id: ProactivityWorkflowId,
  created: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadline: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const proactivityObservationLimit = 8;

export const ProactivityWorkObservations = Schema.Array(ProactivityWorkObservation).check(
  Schema.isMaxLength(proactivityObservationLimit)
);

export type ProactivityWorkObservations = typeof ProactivityWorkObservations.Type;

export const ProactivityActivity = Schema.Union([
  ProactivityDeliveryWork,
  Schema.Struct({
    kind: Schema.Literal("proactivity-generate"),
    version: Schema.Literal(1),
    userId: UserId,
  }),
  Schema.Struct({
    kind: Schema.Literal("proactivity-recover"),
    version: Schema.Literal(1),
    userId: UserId,
    work: ProactivityDeliveryWork,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly-generate"),
    version: Schema.Literal(1),
    userId: UserId,
    id: ScheduleId,
  }),
]);

export type ProactivityActivity = typeof ProactivityActivity.Type;

export const ProactivityActivityResult = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("RecoveryAdmitted", {}),
  Schema.TaggedStruct("Deferred", { nextEligibleAtMs: Schema.Int }),
]);

export type ProactivityActivityResult = typeof ProactivityActivityResult.Type;

type ProactivitySettings = Partial<
  Readonly<{
    PROACTIVITY_ENABLED: string;
    PROACTIVITY_TEMPLATE_JSON: string;
    WEEKLY_SUMMARY_ENABLED: string;
    WEEKLY_SUMMARY_TEMPLATE_JSON: string;
    WEEKLY_QUESTION_TEMPLATE_JSON: string;
    PROACTIVITY_ASK_AFTER: string;
    PROACTIVITY_PAUSE_AFTER: string;
    KAPSO_API_KEY: string;
  }>
>;

export const WeeklyThresholdConfiguration = Schema.toCodecStringTree(ProactivityThresholds);

export class InsightUnavailable extends Data.TaggedError("InsightUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export type NativeReminderEnvironment = UserStoreBindings &
  ProactivitySettings &
  Partial<{ WEEKLY_DELIVERY_QUEUE: Pick<Queue<ProactivityDeliveryWork>, "send"> }>;

export const weeklyPauseMention =
  "Pausé tus resúmenes semanales porque no recibí respuesta. Puedes pedirme que los reactive.";

export const reminderPauseMention =
  "Pausé tus recordatorios de registro manual porque no recibí respuesta. Puedes pedirme que los reactive.";

export type PauseNoticeService = {
  bind: (
    turn: { id: string; user: string; session: string },
    newSession: boolean
  ) => Effect.Effect<void, InsightUnavailable, SqliteClient>;
  include: (
    turn: string,
    text: TranscriptText
  ) => Effect.Effect<TranscriptText, InsightUnavailable, SqliteClient>;
  acknowledge: (turn: string) => Effect.Effect<void, InsightUnavailable, SqliteClient>;
};

export const HostedPauseNotice = Context.Reference<PauseNoticeService>(
  "@fidy/server/cloudflare/insights/contract/HostedPauseNotice",
  {
    defaultValue: (): PauseNoticeService => ({
      bind: (): Effect.Effect<never, InsightUnavailable> =>
        Effect.fail(new InsightUnavailable({ cause: Option.none() })),
      include: (): Effect.Effect<never, InsightUnavailable> =>
        Effect.fail(new InsightUnavailable({ cause: Option.none() })),
      acknowledge: (): Effect.Effect<never, InsightUnavailable> =>
        Effect.fail(new InsightUnavailable({ cause: Option.none() })),
    }),
  }
);
