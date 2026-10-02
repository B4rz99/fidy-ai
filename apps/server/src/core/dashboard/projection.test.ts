import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Widget } from "./contract";
import { dashboardProjectionRanges } from "./operations";

const zone = Schema.decodeSync(IanaTimeZone)("America/New_York");
const dayWidget = Schema.decodeSync(Widget)({
  id: "30000000-0000-4000-8000-000000000001",
  type: "spending-chart",
  groupBy: "day",
  period: "last-week",
});

it("resolves local calendar buckets across a daylight-saving transition", () => {
  if (dayWidget.type === "transaction-list") throw new Error("Expected an aggregate Widget");
  const now = DateTime.makeUnsafe(Date.parse("2026-03-10T12:00:00.000Z"));
  const ranges = dashboardProjectionRanges(dayWidget, now, zone);
  expect(ranges).toHaveLength(7);
  expect(ranges[0]).toEqual({
    key: "2026-03-02",
    from: Date.parse("2026-03-02T05:00:00.000Z"),
    toExclusive: Date.parse("2026-03-03T05:00:00.000Z"),
  });
  expect(ranges[6]).toEqual({
    key: "2026-03-08",
    from: Date.parse("2026-03-08T05:00:00.000Z"),
    toExclusive: Date.parse("2026-03-09T04:00:00.000Z"),
  });
});

it("selects one complete local month for a monthly chart bucket", () => {
  const widget = Schema.decodeSync(Widget)({
    id: "30000000-0000-4000-8000-000000000001",
    type: "spending-chart",
    groupBy: "month",
    period: "last-month",
  });
  if (widget.type === "transaction-list") throw new Error("Expected an aggregate Widget");
  expect(
    dashboardProjectionRanges(widget, DateTime.makeUnsafe(Date.parse("2026-04-02T12:00:00Z")), zone)
  ).toEqual([
    {
      key: "2026-03",
      from: Date.parse("2026-03-01T05:00:00Z"),
      toExclusive: Date.parse("2026-04-01T04:00:00Z"),
    },
  ]);
});
