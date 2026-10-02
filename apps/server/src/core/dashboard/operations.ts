import type { IanaTimeZone } from "~/core/_shared/context";
import type { ProjectedRange, Widget } from "./contract";
import { type DateTime, Function } from "effect";
import * as calculation from "~/core/dashboard/internal/calculation";
import * as aggregation from "~/core/dashboard/internal/aggregation";
import { dashboardProjectionRanges as ranges } from "~/core/dashboard/internal/projection";
import {
  makeDashboardCatalog as catalog,
  makeCatalogWidget as catalogWidget,
  makeDefaultDashboard as defaultDashboard,
} from "~/core/dashboard/internal/catalog";
import { applyDashboardEdit as edit } from "~/core/dashboard/internal/rules";
import {
  collectDashboardCategoryReferences as references,
  collectLayoutWidgets as widgets,
} from "~/core/dashboard/internal/layout";
/** Return the four valid direct-launch Widget presets using the supplied stable restaurant Category. */
export const makeDashboardCatalog: typeof catalog = (input) => catalog(input);
/** Assign one caller-supplied fresh identity to a validated Widget template. */
export const makeCatalogWidget: typeof catalogWidget = (input) => catalogWidget(input);
/** Create a complete, valid first-use Dashboard using four distinct caller-supplied Widget identities. */
export const makeDefaultDashboard: typeof defaultDashboard = (input) => defaultDashboard(input);
/** Apply one edit atomically in memory; reject a missing target or any invalid complete result. */
export const applyDashboardEdit: typeof edit = (input) => edit(input);
/** Traverse the validated layout in the same order used for its mobile presentation. */
export const collectLayoutWidgets: typeof widgets = (node) => widgets(node);
/** Return only the stable Category references needed to validate a candidate document. */
export const collectDashboardCategoryReferences: typeof references = (document) =>
  references(document);

/** Resolve a configured period as half-open UTC bounds in the User's explicit IANA zone. */
export const resolveDashboardPeriod: typeof calculation.resolveDashboardPeriod = (input) =>
  calculation.resolveDashboardPeriod(input);
/** Preserve exact Currency-separated inflows and outflows from decoded sum facts. */
export const dashboardMoneyGroupsFromSums: typeof calculation.dashboardMoneyGroupsFromSums = (
  facts
) => calculation.dashboardMoneyGroupsFromSums(facts);
/** Finalize configured sum, maximum or rounded average without combining Currencies. */
export const dashboardMoneyGroupsFromMetrics: typeof calculation.dashboardMoneyGroupsFromMetrics = (
  facts
) => calculation.dashboardMoneyGroupsFromMetrics(facts);
/** Return the bounded calendar intervals needed by a configured Widget, independent of history size. */
export const dashboardProjectionRanges: typeof ranges = Function.dual(
  3,
  (
    widget: Exclude<Widget, { type: "transaction-list" }>,
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ) => ranges(widget, now, timeZone)
);
/** Project exact chart groups; missing Category metadata makes the entire result unavailable. */
export const projectAggregateChart: typeof aggregation.projectAggregateChart = (input) =>
  aggregation.projectAggregateChart(input);
/** Finalize one configured metric from complete Transaction-owned aggregate contributions. */
export const projectAggregateMetric: typeof aggregation.projectAggregateMetric = Function.dual(
  2,
  (
    widget: Parameters<ReturnType<typeof aggregation.projectAggregateMetric>>[0],
    projected: ReadonlyArray<ProjectedRange>
  ) => aggregation.projectAggregateMetric(widget, projected)
);
/** Sum only the configured Budget Category's outflows in its Currency. */
export const projectAggregateBudgetSpent: typeof aggregation.projectAggregateBudgetSpent =
  Function.dual(
    2,
    (
      widget: Parameters<ReturnType<typeof aggregation.projectAggregateBudgetSpent>>[0],
      projected: ReadonlyArray<ProjectedRange>
    ) => aggregation.projectAggregateBudgetSpent(widget, projected)
  );
