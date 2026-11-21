import { DateTime, Effect, Option } from "effect";
import type {
  RecurringCommand,
  RecurringDocument,
} from "../../../src/core/recurring-plans/contract";
import { RecurringPlanningUnavailable } from "../contract";
import { type AutomaticProjection } from "./query";

const monthWidth = 7;

const retainMonth = <E, R>({
  document,
  retained,
  month,
  now,
  project,
}: Readonly<{
  document: RecurringDocument;
  retained: RecurringDocument["fulfillments"];
  month: string;
  now: DateTime.Utc;
  project: (
    document: RecurringDocument,
    month: string,
    now: DateTime.Utc
  ) => Effect.Effect<AutomaticProjection, E, R>;
}>): Effect.Effect<RecurringDocument["fulfillments"], E | RecurringPlanningUnavailable, R> =>
  Effect.gen(function* () {
    const projection = yield* project({ ...document, fulfillments: retained }, month, now);

    if (!projection.complete) {
      return yield* new RecurringPlanningUnavailable({ cause: Option.none() });
    }

    const extra = projection.document.fulfillments.filter(
      (mark) =>
        mark.automatic === true &&
        projection.matches.some(
          ({ item, fact }) => fact.id === mark.id && item.expectedDate.startsWith(month)
        )
    );

    return retained.filter((mark) => !extra.some((entry) => entry.id === mark.id)).concat(extra);
  });

export const retainCompletions = <E, R>({
  document,
  command,
  now,
  months: selectMonths,
  project,
}: Readonly<{
  document: RecurringDocument;
  command: RecurringCommand;
  now: DateTime.Utc;
  months: (
    from: string,
    through: string
  ) => Effect.Effect<Option.Option<ReadonlyArray<string>>, E, R>;
  project: (
    document: RecurringDocument,
    month: string,
    now: DateTime.Utc
  ) => Effect.Effect<AutomaticProjection, E, R>;
}>): Effect.Effect<RecurringDocument, E | RecurringPlanningUnavailable, R> =>
  Effect.gen(function* () {
    if (document.plans.length === 0 || command.edit.kind === "reverse") return document;
    const through = DateTime.formatIsoDateUtc(DateTime.add(now, { days: 4 })).slice(0, monthWidth);

    const first = document.plans.reduce(
      (date, plan) => (plan.revisions[0].from < date ? plan.revisions[0].from : date),
      `${through}-01`
    );

    const months = yield* selectMonths(
      DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(first), { days: 4 })),
      DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(`${through}-01`), { months: 1 }))
    );

    if (Option.isNone(months)) {
      return yield* new RecurringPlanningUnavailable({ cause: Option.none() });
    }

    const candidates = completionMonths(months.value).filter(
      (month) => month >= first.slice(0, monthWidth) && month <= through
    );

    const fulfillments = yield* Effect.reduce(
      candidates,
      () => document.fulfillments,
      (retained, month) => retainMonth({ document, retained, month, now, project })
    );

    return { ...document, fulfillments };
  });

const completionMonths = (months: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    ...new Set(
      months.flatMap((month) =>
        [-1, 0, 1].map((offset) =>
          DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe(`${month}-01`), { months: offset })
          ).slice(0, monthWidth)
        )
      )
    ),
  ].sort();
