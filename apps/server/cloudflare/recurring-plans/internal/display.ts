import type { RecurringDocument } from "../../../src/core/recurring-plans/contract";

/** Compact displays retain current plan settings; historical calculations still use the full ledger. */
export const displayDocument = ({
  document,
  compact,
}: Readonly<{ document: RecurringDocument; compact: boolean }>): RecurringDocument =>
  !compact
    ? document
    : {
        ...document,
        plans: document.plans.map((plan) => ({
          ...plan,
          revisions: [plan.revisions.at(-1) ?? plan.revisions[0]],
        })),
      };
