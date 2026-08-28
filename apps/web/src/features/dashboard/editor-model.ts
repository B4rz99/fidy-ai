import { type Result, Schema } from "effect";
import { DashboardEdit, WidgetId as WidgetIdSchema } from "@/transport/client";
import type { CanonicalSuccess } from "@/transport/client";
import type { DashboardDropTarget } from "./drag-data";

type CanonicalDashboardEdit = DashboardEdit;
type AddWidgetEdit = Extract<CanonicalDashboardEdit, { readonly op: "add-widget" }>;
type ResizeRegionEdit = Extract<CanonicalDashboardEdit, { readonly op: "resize-region" }>;
type Placement = AddWidgetEdit["at"];
type DashboardWidget = AddWidgetEdit["widget"];
type WidgetId = DashboardWidget["id"];

const uuidOctets = 16;
const uuidVersionOctet = 6;
const uuidVariantOctet = 8;
const lowNibbleMask = 0x0f;
const lowSixBitsMask = 0x3f;
const uuidVersionFourBits = 0x40;
const uuidRfcVariantBits = 0x80;
const hexadecimalRadix = 16;
const firstGroupEnd = 8;
const secondGroupEnd = 12;
const thirdGroupEnd = 16;
const fourthGroupEnd = 20;

/** Generates one schema-decoded browser Widget identity for a canonical add operation. */
export const freshWidgetId = (): WidgetId => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(uuidOctets));
  const versionOctet = Schema.decodeUnknownSync(Schema.Int)(bytes[uuidVersionOctet]);
  const variantOctet = Schema.decodeUnknownSync(Schema.Int)(bytes[uuidVariantOctet]);
  bytes[uuidVersionOctet] = (versionOctet & lowNibbleMask) | uuidVersionFourBits;
  bytes[uuidVariantOctet] = (variantOctet & lowSixBitsMask) | uuidRfcVariantBits;
  const hex = Array.from(bytes, (byte) => byte.toString(hexadecimalRadix).padStart(2, "0")).join(
    ""
  );
  return Schema.decodeUnknownSync(WidgetIdSchema)(
    `${hex.slice(0, firstGroupEnd)}-${hex.slice(firstGroupEnd, secondGroupEnd)}-${hex.slice(secondGroupEnd, thirdGroupEnd)}-${hex.slice(thirdGroupEnd, fourthGroupEnd)}-${hex.slice(fourthGroupEnd)}`
  );
};

/** One decoded preset returned by the canonical Dashboard catalog query. */
export type DashboardCatalogEntry =
  CanonicalSuccess<"dashboard.listDashboardCatalog">["data"][number];

/**
 * Closed browser interaction vocabulary. Values remain untrusted until compilation decodes the
 * resulting canonical DashboardEdit; a successful result is ready for the typed client.
 */
export type DashboardGesture =
  | Readonly<{ kind: "move-widget"; widgetId: WidgetId; target: DashboardDropTarget }>
  | Readonly<{ kind: "swap-widgets"; widgetId: WidgetId; withWidgetId: WidgetId }>
  | Readonly<{
      kind: "add-catalog-widget";
      entry: DashboardCatalogEntry;
      newWidgetId: WidgetId;
      target: DashboardDropTarget;
    }>
  | Readonly<{
      kind: "resize-region";
      widgetIds: ResizeRegionEdit["widgetIds"];
      weight: number;
    }>
  | Readonly<{ kind: "remove-widget"; widgetId: WidgetId }>
  | Readonly<{ kind: "retitle-widget"; title: string; widget: DashboardWidget }>;

const placementFor = (target: Readonly<DashboardDropTarget>): Placement => {
  if (target.kind === "dashboard-edge") return target.edge;
  switch (target.edge) {
    case "top":
      return { besideWidget: target.widgetId, axis: "column", side: "before" };
    case "right":
      return { besideWidget: target.widgetId, axis: "row", side: "after" };
    case "bottom":
      return { besideWidget: target.widgetId, axis: "column", side: "after" };
    case "left":
      return { besideWidget: target.widgetId, axis: "row", side: "before" };
    case "center":
      return { besideWidget: target.widgetId, axis: "row", side: "after" };
  }
};

const editFor = (gesture: Readonly<DashboardGesture>): unknown => {
  switch (gesture.kind) {
    case "move-widget":
      return { op: "move-widget", widgetId: gesture.widgetId, at: placementFor(gesture.target) };
    case "swap-widgets":
      return {
        op: "swap-widgets",
        widgetId: gesture.widgetId,
        withWidgetId: gesture.withWidgetId,
      };
    case "add-catalog-widget":
      return {
        op: "add-widget",
        widget: { id: gesture.newWidgetId, ...gesture.entry.widget },
        at: placementFor(gesture.target),
      };
    case "resize-region":
      return {
        op: "resize-region",
        widgetIds: gesture.widgetIds,
        size: { kind: "weight", weight: gesture.weight },
      };
    case "remove-widget":
      return { op: "remove-widget", widgetId: gesture.widgetId };
    case "retitle-widget":
      return { op: "update-widget", widget: { ...gesture.widget, title: gesture.title } };
  }
};

/** Compiles exactly one UI gesture and proves it against the server-owned DashboardEdit schema. */
export const compileDashboardGesture = (
  gesture: Readonly<DashboardGesture>
): Result.Result<CanonicalDashboardEdit, Schema.SchemaError> =>
  Schema.decodeUnknownResult(DashboardEdit)(editFor(gesture));
