import { BrowserSessionBinding } from "@fidy/server/browser-bootstrap";
import { Option, Schema } from "effect";

export type InitialDashboardHtml = Readonly<{ status: number; html: string }>;
let initial = Option.none<InitialDashboardHtml & Readonly<{ binding: string }>>();
const Status = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 200, maximum: 599 })
);

/** Capture the document's one-use transfer before React replaces the entry markup. */
export const captureInitialDashboardHtml = (): void => {
  const element = document.getElementById("dashboard-initial");
  if (element === null) return;
  const binding = Schema.decodeUnknownOption(BrowserSessionBinding.fields.binding)(
    element.dataset.binding
  );
  const status = Schema.decodeUnknownOption(Status)(element.dataset.status);
  if (Option.isNone(binding) || binding.value === null || Option.isNone(status)) return;
  initial = Option.some({ binding: binding.value, status: status.value, html: element.innerHTML });
};

/** Consume once for the exact mounted session; a different authentication lifetime discards it. */
export const takeInitialDashboardHtml = (binding: string): Option.Option<InitialDashboardHtml> => {
  const available = initial;
  initial = Option.none();
  return Option.filter(available, (entry) => entry.binding === binding);
};
