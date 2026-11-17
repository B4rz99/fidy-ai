import { useRouter, useRouterState } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { RecurringFilters, RecurringMonth } from "@/transport/client";
import type { Filters } from "./model";

const WorkspaceView = Schema.Struct({
  binding: Schema.String,
  filters: RecurringFilters,
  previous: Schema.optional(RecurringMonth),
});
const HistoryView = Schema.Struct({ recurringWorkspace: WorkspaceView });
type WorkspaceView = typeof WorkspaceView.Type;

export const useRecurringWorkspaceView = (): Readonly<{
  filters: Filters;
  previous: Option.Option<string>;
  applyFilters: (filters: Filters) => void;
  earlier: (month: string) => void;
}> => {
  const router = useRouter();
  const state = useRouterState({ select: (value) => value.location.state });
  const binding = router.options.context.sessionBinding;
  const view = Schema.decodeUnknownOption(HistoryView)(state).pipe(
    Option.map(({ recurringWorkspace }) => recurringWorkspace),
    Option.filter((value) => value.binding === binding),
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
      .catch(() => undefined);
  };
  return {
    filters: view.filters,
    previous: Option.fromUndefinedOr(view.previous),
    applyFilters: (filters) => save({ ...view, filters }),
    earlier: (previous) => save({ ...view, previous }),
  };
};
