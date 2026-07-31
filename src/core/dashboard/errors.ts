import { Data } from "effect";
import type { WidgetId } from "./model";

/** One actionable invariant violation found by the complete-document validation gate. */
export type DashboardIssue = Readonly<{
  readonly path?: string;
  readonly message: string;
}>;

/** The transformed aggregate failed its complete second validation gate. */
export class InvalidDashboardResult extends Data.TaggedError("InvalidDashboardResult")<{
  readonly issues: readonly [DashboardIssue, ...Array<DashboardIssue>];
}> {}

/** The edit or its placement references no Widget in the latest document. */
export class WidgetNotFound extends Data.TaggedError("WidgetNotFound")<{
  readonly widgetId: WidgetId;
  readonly role: "edit-target" | "placement-target";
}> {}

/** A root leaf has no sibling-relative region whose weight can change. */
export class RootWidgetResize extends Data.TaggedError("RootWidgetResize")<{
  readonly widgetId: WidgetId;
}> {}

/** A move cannot use its own Widget as the sibling destination. */
export class SelfPlacement extends Data.TaggedError("SelfPlacement")<{
  readonly widgetId: WidgetId;
}> {}

/** Removing the only remaining Widget would make the dashboard empty. */
export class LastWidgetRemoval extends Data.TaggedError("LastWidgetRemoval")<{
  readonly widgetId: WidgetId;
}> {}

/** An added Widget must introduce an identity absent from the latest document. */
export class DuplicateWidgetId extends Data.TaggedError("DuplicateWidgetId")<{
  readonly widgetId: WidgetId;
}> {}

/** Closed set of pure failures returned by one atomic Dashboard edit. */
export type DashboardFailure =
  | InvalidDashboardResult
  | WidgetNotFound
  | RootWidgetResize
  | SelfPlacement
  | LastWidgetRemoval
  | DuplicateWidgetId;
