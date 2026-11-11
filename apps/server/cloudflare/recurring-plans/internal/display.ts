import { DateTime } from "effect";
import type { RecurringDocument } from "../../../src/core/recurring-plans/contract";

export const displayDocument = ({
  document,
  compact,
  now,
}: Readonly<{
  document: RecurringDocument;
  compact: boolean;
  now: DateTime.Utc;
}>): RecurringDocument => {
  if (!compact) return document;
  const from = DateTime.formatIsoDateUtc(DateTime.subtract(now, { days: 1 }));
  const through = DateTime.formatIsoDateUtc(DateTime.add(now, { days: 1 }));
  return {
    ...document,
    plans: document.plans.map((plan) => {
      const preceding = plan.revisions.findLast((revision) => revision.from <= from);
      return {
        ...plan,
        revisions: [
          plan.revisions[0],
          ...plan.revisions
            .slice(1)
            .filter(
              (revision, index) =>
                index === plan.revisions.length - 2 ||
                revision === preceding ||
                (revision.from >= from && revision.from <= through)
            ),
        ],
      };
    }),
  };
};
