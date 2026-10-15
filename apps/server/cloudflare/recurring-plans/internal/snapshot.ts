import { DateTime, Effect, Option } from "effect";
import type {
  RecurringCommand,
  RecurringDocument,
} from "../../../src/core/recurring-plans/contract";
import { RecurringPlanningUnavailable } from "../contract";
import type { CanonicalPreparationWork } from "../../canonical-operations/contract";
import { readPlanningTransactionMonths } from "../../transactions/operations";
import { automaticProjection } from "./query";

const monthWidth = 7;

/** Materialize existing effective completions only inside an explicit coordinated mutation.
 * Otherwise a new competing plan or a backdated schedule edit could rewrite completed history.
 */
export const snapshotCompletions = ({
  work,
  document,
  command,
}: Readonly<{
  work: CanonicalPreparationWork;
  document: RecurringDocument;
  command: RecurringCommand;
}>): Effect.Effect<RecurringDocument, RecurringPlanningUnavailable> =>
  Effect.gen(function* () {
    if (document.plans.length === 0 || command.edit.kind === "reverse") return document;
    const now = DateTime.makeUnsafe(work.current);
    const through = DateTime.formatIsoDateUtc(DateTime.add(now, { days: 4 })).slice(0, monthWidth);
    const first = document.plans.reduce(
      (date, plan) => (plan.revisions[0].from < date ? plan.revisions[0].from : date),
      `${through}-01`
    );
    const months = yield* readPlanningTransactionMonths({
      db: work.db,
      userId: work.subject.userId,
      from: DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(first), { days: 4 })),
      through: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(`${through}-01`), { months: 1 })
      ),
    });
    if (Option.isNone(months)) return yield* new RecurringPlanningUnavailable();
    const candidates = completionMonths(months.value).filter(
      (month) => month >= first.slice(0, monthWidth) && month <= through
    );
    let retained = document;
    for (const month of candidates) {
      const projection = yield* automaticProjection({
        db: work.db,
        userId: work.subject.userId,
        document: retained,
        month,
        now,
      });
      // Incomplete reads cannot establish a safe allocation boundary for an edit.
      if (!projection.complete) return yield* new RecurringPlanningUnavailable();
      const extra = projection.document.fulfillments.filter(
        (mark) =>
          mark.automatic === true &&
          projection.matches.some(
            ({ item, fact }) => fact.id === mark.id && item.expectedDate.startsWith(month)
          )
      );
      retained = {
        ...retained,
        fulfillments: [
          ...retained.fulfillments.filter((mark) => !extra.some((entry) => entry.id === mark.id)),
          ...extra,
        ],
      };
    }
    return retained;
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
