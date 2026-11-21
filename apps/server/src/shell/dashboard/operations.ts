import {
  type DashboardFailure,
  type DashboardIssue,
  type InvalidDashboardResult,
  type WidgetNotFound,
} from "~/core/dashboard/contract";
import { NotFound, type SuggestedOperation, ValidationFailed } from "~/shell/public-http/contract";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/canonical-operations/operations";

import { Effect, Match, Option, Predicate, Schema } from "effect";
import {
  type DashboardApiFailure,
  type DashboardCategoryNotFound,
  DashboardUnavailable,
  DashboardView,
} from "./contract";
import { renderDashboardView as render } from "~/shell/dashboard/internal/presentation";

const decodeDashboardView = Schema.decodeEffect(Schema.toType(DashboardView));

export const renderDashboardView: typeof render = (input) =>
  render(input).pipe(
    Effect.flatMap(decodeDashboardView),
    Effect.mapError((cause) => new DashboardUnavailable({ cause }))
  );

const dashboardRecovery = (caller: SuggestedOperationCaller): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "dashboard.getDashboard",
        hint: "Get the latest dashboard before choosing widget ids or applying another edit.",
      }),
    ],
    caller,
  });

const categoryRecovery = (caller: SuggestedOperationCaller): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "categories.listCategories",
        hint: "List Categories to choose one available for dashboard widgets.",
      }),
    ],
    caller,
  });

const widgetNotFoundFailure = (
  failure: WidgetNotFound,
  caller: SuggestedOperationCaller
): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message:
        failure.role === "placement-target"
          ? `No widget ${failure.widgetId} is available as a placement target. Choose a WidgetId from the latest dashboard.`
          : `No widget ${failure.widgetId} is available to edit. Choose a WidgetId from the latest dashboard.`,
    },
    next: dashboardRecovery(caller),
  });

type NonInvalidDashboardFailure = Exclude<
  DashboardFailure | DashboardCategoryNotFound,
  InvalidDashboardResult
>;

const categoryNotFoundFailure = (
  failure: DashboardCategoryNotFound,
  caller: SuggestedOperationCaller
): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message: `Category ${failure.categoryId} is not available for dashboard widgets. Choose an available Category and resend the complete edit.`,
      fields: [
        {
          path: failure.path,
          message: "Expected a Category available to the authenticated User.",
        },
      ],
    },
    next: categoryRecovery(caller),
  });

const toNonInvalidApiFailure = (
  failure: NonInvalidDashboardFailure,
  caller: SuggestedOperationCaller
): DashboardApiFailure =>
  Match.valueTags(failure, {
    WidgetNotFound: (failure) => widgetNotFoundFailure(failure, caller),
    DashboardCategoryNotFound: (failure) => categoryNotFoundFailure(failure, caller),
    DuplicateWidgetId: (failure) =>
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: `WidgetId ${failure.widgetId} is already present in the dashboard. Generate a fresh WidgetId and resend the complete edit.`,
          fields: [{ path: "widget.id", message: "Expected a fresh WidgetId." }],
        },
        next: dashboardRecovery(caller),
      }),
    LastWidgetRemoval: () =>
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "A dashboard must retain at least one widget. Add another widget before removing this one.",
          fields: [{ path: "widgetId", message: "Expected a removable non-final widget." }],
        },
        next: dashboardRecovery(caller),
      }),
    RootRegionResize: () =>
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "The root region has no sibling-relative weight to resize. Add a sibling before resizing it.",
          fields: [{ path: "widgetIds", message: "Expected a child region inside a split." }],
        },
        next: dashboardRecovery(caller),
      }),
    RegionNotFound: () =>
      NotFound.make({
        error: {
          code: "not_found",
          message:
            "No current layout region contains exactly those widgets. Get the latest dashboard and choose one complete child region.",
        },
        next: dashboardRecovery(caller),
      }),
    SelfPlacement: () =>
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: "A widget cannot be placed beside itself. Choose a different placement target.",
          fields: [
            { path: "at.besideWidget", message: "Expected a different WidgetId from widgetId." },
          ],
        },
        next: dashboardRecovery(caller),
      }),
  });

const toFieldIssue = (issue: DashboardIssue): ValidationFailed["error"]["fields"][number] =>
  Option.match(issue.path, {
    onNone: () => ({ message: issue.message }),
    onSome: (path) => ({ path, message: issue.message }),
  });

export const toApiFailure = ({
  failure,
  caller,
}: {
  readonly failure: DashboardFailure | DashboardCategoryNotFound;
  readonly caller: SuggestedOperationCaller;
}): DashboardApiFailure =>
  Predicate.isTagged(failure, "InvalidDashboardResult")
    ? ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "The edit would produce an invalid DashboardDocument. Correct every reported field and resend the complete edit.",
          fields: failure.issues.map(toFieldIssue),
        },
        next: dashboardRecovery(caller),
      })
    : toNonInvalidApiFailure(failure, caller);
