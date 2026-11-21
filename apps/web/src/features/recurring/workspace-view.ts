import { useRouter, useRouterState } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { useState } from "react";
import { RecurringFilters, RecurringMonth } from "@/transport/client";
import type { Filters } from "./model";
import { reportBrowserDefect } from "@/transport/browser-defects";

const WorkspaceView = Schema.Struct({
  binding: Schema.String,
  filters: RecurringFilters,
  previous: Schema.optional(RecurringMonth),
});

const HistoryView = Schema.Struct({ recurringWorkspace: WorkspaceView });

type WorkspaceView = typeof WorkspaceView.Type;

type RecurringWorkspaceViewControl = Readonly<{
  filters: Filters;
  previous: Option.Option<string>;
  applyFilters: (filters: Filters) => void;
  earlier: (month: string) => void;
  selectMonth: (month: string) => void;
}>;

export const useRecurringWorkspaceView = (): RecurringWorkspaceViewControl => {
  const router = useRouter();
  const state = useRouterState({ select: (value) => value.location.state });
  const binding = router.options.context.sessionBinding;

  const restored = Schema.decodeUnknownOption(HistoryView)(state).pipe(
    Option.map(({ recurringWorkspace }) => recurringWorkspace),
    Option.filter((value) => value.binding === binding)
  );

  const [retained, retain] = useState(() => restored);

  if (
    Option.isSome(restored) &&
    !Option.exists(retained, (value) => JSON.stringify(value) === JSON.stringify(restored.value))
  ) {
    retain(restored);
  }

  const view = restored.pipe(
    Option.orElse(() => Option.filter(retained, (value) => value.binding === binding)),
    Option.getOrElse((): WorkspaceView => ({ binding, filters: {} }))
  );

  const save = (next: WorkspaceView): void => {
    router
      .navigate({
        to: ".",
        search: true,
        replace: true,
        resetScroll: false,
        state: (previous) => ({ ...previous, recurringWorkspace: next }),
      })
      .catch(() => reportBrowserDefect("navigation_failed"));
  };

  return {
    selectMonth: (month) => {
      router
        .navigate({
          to: "/app/recurring",
          search: { month },
          state: (previous) => ({
            ...previous,
            recurringWorkspace: view,
            recurringView: undefined,
          }),
        })
        .catch(() => reportBrowserDefect("navigation_failed"));
    },
    filters: view.filters,
    previous: Option.fromUndefinedOr(view.previous),
    applyFilters: (filters) => save({ ...view, filters }),
    earlier: (previous) => save({ ...view, previous }),
  };
};
