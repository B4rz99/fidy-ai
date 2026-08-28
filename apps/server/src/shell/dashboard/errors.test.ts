import { Option, Schema } from "effect";
import { expect, it } from "vitest";
import { CategoryId } from "~/core/categories/reference";
import {
  DuplicateWidgetId,
  InvalidDashboardResult,
  LastWidgetRemoval,
  RegionNotFound,
  RootRegionResize,
  SelfPlacement,
  WidgetNotFound,
} from "~/core/dashboard/errors";
import { LayoutRegionSelector, WidgetId } from "~/core/dashboard/model";
import { DashboardCategoryNotFound, toApiFailure } from "./errors";

const widgetId = Schema.decodeUnknownSync(WidgetId)("f1d1a000-0000-4000-8000-000000000991");
const widgetIds = Schema.decodeUnknownSync(LayoutRegionSelector)([widgetId]);
const categoryId = Schema.decodeUnknownSync(CategoryId)("f1d1a000-0000-4000-8000-000000000992");
const caller = {
  accessCaller: { _tag: "PAT" as const, capabilities: ["dashboard" as const] },
  tier: "free" as const,
};

it("maps every closed Dashboard failure without leaking rejected state", () => {
  const failures = [
    new WidgetNotFound({ widgetId, role: "edit-target" }),
    new WidgetNotFound({ widgetId, role: "placement-target" }),
    new DashboardCategoryNotFound({ categoryId, path: "widget.categoryId" }),
    new DuplicateWidgetId({ widgetId }),
    new LastWidgetRemoval({ widgetId }),
    new RootRegionResize({ widgetIds }),
    new RegionNotFound({ widgetIds }),
    new SelfPlacement({ widgetId }),
    new InvalidDashboardResult({
      issues: [
        { path: Option.none(), message: "document issue" },
        { path: Option.some("layout"), message: "layout issue" },
      ],
    }),
  ] as const;

  expect(failures.map((failure) => toApiFailure({ caller, failure }).error.code)).toEqual([
    "not_found",
    "not_found",
    "validation_failed",
    "validation_failed",
    "validation_failed",
    "validation_failed",
    "not_found",
    "validation_failed",
    "validation_failed",
  ]);
});
