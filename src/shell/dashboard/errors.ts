import { Data, Option } from "effect";
import { type CategoryId } from "~/core/categories/reference";
import { type DashboardFailure, type DashboardIssue } from "~/core/dashboard/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import type { SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

/** A candidate dashboard references a Category unavailable to the authenticated User. */
export class DashboardCategoryNotFound extends Data.TaggedError("DashboardCategoryNotFound")<{
  readonly categoryId: CategoryId;
  readonly path: string;
}> {}

/** Declared canonical failures returned by dashboard operations. */
export type DashboardApiFailure = NotFound | ValidationFailed;

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
  failure: Readonly<Extract<DashboardFailure, { readonly _tag: "WidgetNotFound" }>>,
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
  { readonly _tag: "InvalidDashboardResult" }
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
): DashboardApiFailure => {
  switch (failure._tag) {
    case "WidgetNotFound":
      return widgetNotFoundFailure(failure, caller);
    case "DashboardCategoryNotFound":
      return categoryNotFoundFailure(failure, caller);
    case "DuplicateWidgetId":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: `WidgetId ${failure.widgetId} is already present in the dashboard. Generate a fresh WidgetId and resend the complete edit.`,
          fields: [{ path: "widget.id", message: "Expected a fresh WidgetId." }],
        },
        next: dashboardRecovery(caller),
      });
    case "LastWidgetRemoval":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "A dashboard must retain at least one widget. Add another widget before removing this one.",
          fields: [{ path: "widgetId", message: "Expected a removable non-final widget." }],
        },
        next: dashboardRecovery(caller),
      });
    case "RootWidgetResize":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "The root widget has no sibling-relative weight to resize. Add a sibling before resizing it.",
          fields: [{ path: "weight", message: "Expected a widget inside a split region." }],
        },
        next: dashboardRecovery(caller),
      });
    case "SelfPlacement":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: "A widget cannot be placed beside itself. Choose a different placement target.",
          fields: [
            { path: "at.besideWidget", message: "Expected a different WidgetId from widgetId." },
          ],
        },
        next: dashboardRecovery(caller),
      });
  }
};

const toFieldIssue = (
  issue: DashboardIssue
): Readonly<{ message: string }> | Readonly<{ path: string; message: string }> =>
  Option.match(issue.path, {
    onNone: () => ({ message: issue.message }),
    onSome: (path) => ({ path, message: issue.message }),
  });

/** Maps dashboard decisions to compact canonical failures without rejected document data. */
export const toApiFailure = ({
  failure,
  caller,
}: {
  readonly failure: DashboardFailure | DashboardCategoryNotFound;
  readonly caller: SuggestedOperationCaller;
}): DashboardApiFailure =>
  failure._tag === "InvalidDashboardResult"
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
