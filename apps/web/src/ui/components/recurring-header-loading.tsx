import type { JSX } from "react";
import { Add01Icon, FilterHorizontalIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RecurringControlSkeleton } from "./recurring-control-loading";

export const RecurringHeaderSkeleton = (): JSX.Element => (
  <header data-recurring-slot="page-header">
    <div data-recurring-slot="title-tabs">
      <h1>Recurrentes</h1>
      <div data-recurring-slot="tabs">
        {["Mensual", "Todos los recurrentes"].map((label) => (
          <RecurringControlSkeleton key={label} size="sm">
            {label}
          </RecurringControlSkeleton>
        ))}
      </div>
    </div>
    <div data-recurring-slot="header-actions">
      {[
        { label: "Filtros", icon: FilterHorizontalIcon },
        { label: "Administrar", icon: Settings01Icon },
        { label: "Nuevo recurrente", icon: Add01Icon },
      ].map(({ label, icon }) => (
        <RecurringControlSkeleton key={label} size="sm">
          <HugeiconsIcon icon={icon} data-icon="inline-start" />
          {label}
        </RecurringControlSkeleton>
      ))}
    </div>
  </header>
);
