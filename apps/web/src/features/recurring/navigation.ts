import { type RegisteredRouter, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Option, Schema } from "effect";
import { RecurringDate, RecurringPlanId } from "@/transport/client";
import type { Filters, Occurrence } from "./model";
import {
  type TransactionBrowserControl,
  TransactionBrowserState,
  type TransactionFilters,
  transactionSearch,
} from "./transaction-filters";
import { reportBrowserDefect } from "@/transport/browser-defects";

type WorkspaceScope = Readonly<{
  month: string;
  filters: Filters;
  previous: Option.Option<string>;
}>;

type Scope = Readonly<{ key: string; workspace: WorkspaceScope }>;

type OccurrenceIdentity = Pick<Occurrence, "planId" | "date">;

const OccurrenceSelection = Schema.Struct({
  kind: Schema.Literal("occurrence"),
  planId: RecurringPlanId,
  date: RecurringDate,
});

const LinkSelection = Schema.Struct({
  kind: Schema.Literal("link"),
  planId: RecurringPlanId,
  date: RecurringDate,
  occurrenceIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pickerIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  browser: TransactionBrowserState,
});

const Selection = Schema.Union([OccurrenceSelection, LinkSelection]);

type Selection = typeof Selection.Type;

const SavedView = Schema.Struct({
  binding: Schema.String,
  scope: Schema.String,
  selection: Schema.optionalKey(Selection),
});

const HistoryView = Schema.Struct({ recurringView: SavedView });

const readSelection = (state: unknown, binding: string, scope: Scope): Option.Option<Selection> =>
  Schema.decodeUnknownOption(HistoryView)(state).pipe(
    Option.filter(
      ({ recurringView }) => recurringView.binding === binding && recurringView.scope === scope.key
    ),
    Option.flatMap(({ recurringView }) => Option.fromUndefinedOr(recurringView.selection))
  );

const saveSelection = ({
  router,
  scope,
  selection,
  replace,
}: Readonly<{
  router: RegisteredRouter;
  scope: Scope;
  selection: Option.Option<Selection>;
  replace: boolean;
}>): void => {
  router
    .navigate({
      to: ".",
      search: true,
      resetScroll: false,
      replace,
      state: (previous) => ({
        ...previous,
        recurringWorkspace: {
          binding: router.options.context.sessionBinding,
          filters: scope.workspace.filters,
          previous: Option.getOrUndefined(scope.workspace.previous),
        },
        recurringView: {
          binding: router.options.context.sessionBinding,
          scope: scope.key,
          selection: Option.getOrUndefined(selection),
        },
      }),
    })
    .catch(() => reportBrowserDefect("navigation_failed"));
};

export type RecurringNavigation = Readonly<{
  selection: Option.Option<Selection>;
  open: (item: OccurrenceIdentity) => void;
  link: (item: OccurrenceIdentity, filters: TransactionFilters) => void;
  browser: Option.Option<TransactionBrowserControl>;
  close: () => void;
  returnToOccurrence: () => void;
}>;

const linkSelection = (
  selection: Option.Option<Selection>
): Option.Option<typeof LinkSelection.Type> =>
  Option.filter(selection, (value) => value.kind === "link");

const sameOccurrence = (left: OccurrenceIdentity, right: OccurrenceIdentity): boolean =>
  left.planId === right.planId && left.date === right.date;

const validBrowser = (selection: Selection): boolean =>
  selection.kind !== "link" ||
  Option.isSome(
    transactionSearch({ draft: selection.browser.applied, timeZone: "America/Bogota" })
  );

const makeLinkSelection = ({
  item,
  filters,
  index,
  remembered,
}: Readonly<{
  item: OccurrenceIdentity;
  filters: TransactionFilters;
  index: number;
  remembered: Option.Option<typeof LinkSelection.Type>;
}>): typeof LinkSelection.Type => {
  const previous = Option.filter(remembered, (value) => sameOccurrence(value, item));

  const browser = Option.match(previous, {
    onNone: () => ({ draft: filters, applied: filters, cursors: [] }),
    onSome: (value) => ({ ...value.browser, selectedId: undefined }),
  });

  const next = {
    ...item,
    kind: "link" as const,
    browser,
    occurrenceIndex: index,
    pickerIndex: index + 1,
  };

  return next;
};

export const useRecurringNavigation = (workspace: WorkspaceScope): RecurringNavigation => {
  const scope = {
    key: `${workspace.month}:${JSON.stringify(workspace.filters)}:${Option.getOrElse(workspace.previous, () => "")}`,
    workspace,
  };

  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });

  const selection = readSelection(
    location.state,
    router.options.context.sessionBinding,
    scope
  ).pipe(Option.filter(validBrowser));

  const [remembered, remember] = useState(() => linkSelection(selection));

  const save = (value: Option.Option<Selection>, replace: boolean): void =>
    saveSelection({ router, scope, selection: value, replace });

  const link = (item: OccurrenceIdentity, filters: TransactionFilters): void => {
    const next = makeLinkSelection({
      item,
      filters,
      index: location.state.__TSR_index,
      remembered,
    });

    remember(Option.some(next));
    save(Option.some(next), false);
  };

  const changeBrowser = (browser: TransactionBrowserState, replace: boolean): void => {
    const current = linkSelection(selection);

    if (Option.isNone(current)) return;
    const next = { ...current.value, browser };
    remember(Option.some(next));

    if (
      replace &&
      current.value.browser.selectedId !== undefined &&
      browser.selectedId === undefined
    ) {
      restorePicker({ router, scope, value: next });
    } else save(Option.some(next), replace);
  };

  return {
    selection,
    open: (item) => save(Option.some({ ...item, kind: "occurrence" }), false),
    link,
    browser: Option.map(linkSelection(selection), (value) => ({
      state: value.browser,
      change: (browser) => changeBrowser(browser, true),
      select: (selectedId) =>
        changeBrowser({ ...value.browser, selectedId }, value.browser.selectedId !== undefined),
      clear: () =>
        restorePicker({
          router,
          scope,
          value: { ...value, browser: { ...value.browser, selectedId: undefined } },
        }),
    })),
    close: () =>
      closeCurrent({ router, scope, key: Option.fromUndefinedOr(location.state.__TSR_key) }),
    returnToOccurrence: () => returnToOccurrence({ router, scope, selection }),
  };
};

const returnToIndex = ({
  router,
  index,
  fallback,
}: Readonly<{ router: RegisteredRouter; index: number; fallback: () => void }>): void => {
  const distance = router.latestLocation.state.__TSR_index - index;

  if (distance > 0 && distance <= 2) router.history.go(-distance);
  else fallback();
};

const closeCurrent = ({
  router,
  scope,
  key,
}: Readonly<{ router: RegisteredRouter; scope: Scope; key: Option.Option<string> }>): void => {
  if (Option.contains(key, router.latestLocation.state.__TSR_key ?? "")) {
    saveSelection({ router, scope, selection: Option.none(), replace: true });
  }
};

const restorePicker = ({
  router,
  scope,
  value,
}: Readonly<{
  router: RegisteredRouter;
  scope: Scope;
  value: typeof LinkSelection.Type;
}>): void => {
  const binding = router.options.context.sessionBinding;

  const save = (): void =>
    saveSelection({ router, scope, selection: Option.some(value), replace: true });

  const distance = router.latestLocation.state.__TSR_index - value.pickerIndex;

  if (distance <= 0 || distance > 2) {
    save();

    return;
  }

  const finish = (): void => {
    stop();
    const location = router.history.location;

    if (
      location.state.__TSR_index !== value.pickerIndex ||
      router.options.context.sessionBinding !== binding
    ) {
      return;
    }

    const target = readSelection(location.state, binding, scope);

    if (
      Option.exists(
        target,
        (selection) => selection.kind === "link" && sameOccurrence(selection, value)
      )
    ) {
      save();
    }
  };

  const stop = router.history.subscribe(finish);
  router.history.go(-distance);
};

const returnToOccurrence = ({
  router,
  scope,
  selection,
}: Readonly<{
  router: RegisteredRouter;
  scope: Scope;
  selection: Option.Option<Selection>;
}>): void => {
  const current = linkSelection(selection);

  if (Option.isNone(current)) return;
  const value = current.value;
  returnToIndex({
    router,
    index: value.occurrenceIndex,
    fallback: () =>
      saveSelection({
        router,
        scope,
        selection: Option.some({ kind: "occurrence", planId: value.planId, date: value.date }),
        replace: true,
      }),
  });
};
