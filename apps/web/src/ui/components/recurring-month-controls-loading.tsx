import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { RecurringControlSkeleton } from "./recurring-control-loading";
import { Skeleton } from "./skeleton";

export const RecurringMonthControlsSkeleton = (): JSX.Element => (
  <div data-recurring-slot="month-controls">
    <h2>
      <Skeleton className="h-6 w-44" />
    </h2>
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {[0, 1].map((arrow) => (
          <RecurringControlSkeleton key={arrow} size="icon-sm" />
        ))}
      </div>
      <div data-recurring-slot="presentation-toggle">
        {[
          { label: "Lista", icon: Menu01Icon },
          { label: "Calendario", icon: Calendar03Icon },
        ].map(({ label, icon }) => (
          <RecurringControlSkeleton key={label} size="sm">
            <HugeiconsIcon icon={icon} data-icon="inline-start" />
            {label}
          </RecurringControlSkeleton>
        ))}
      </div>
    </div>
  </div>
);
