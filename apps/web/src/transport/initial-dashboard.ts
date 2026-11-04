import { BrowserSessionBinding } from "@fidy/server/browser-bootstrap";
import { Option, Schema } from "effect";
import { takeInitialDocumentHtml } from "./initial-dashboard-document";

export { captureInitialDashboardHtml } from "./initial-dashboard-document";

export type InitialDashboardHtml = Readonly<{ status: number; html: string }>;
const Status = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 200, maximum: 599 })
);

/** Consume once for the exact mounted session; a different authentication lifetime discards it. */
export const takeInitialDashboardHtml = (binding: string): Option.Option<InitialDashboardHtml> => {
  const available = takeInitialDocumentHtml();
  if (available._tag === "Missing") return Option.none();
  const identity = Schema.decodeOption(BrowserSessionBinding.fields.binding)(available.binding);
  const status = Schema.decodeOption(Status)(available.status);
  if (Option.isNone(identity) || identity.value !== binding || Option.isNone(status)) {
    return Option.none();
  }
  return Option.some({ binding, status: status.value, html: available.html });
};
