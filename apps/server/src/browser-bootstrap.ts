/** Narrow browser bootstrap surface, derived from the same published endpoint declaration. */
import { HttpApi } from "effect/http-api";
import { BrowserSessionGroup } from "~/shell/web-session/contract";

export {
  BrowserSessionBinding,
  type BrowserSessionInitialContext,
  type InitialTransactionPage,
} from "~/shell/web-session/contract";
export {
  browserSessionBindingHeader,
  isHttpOrigin,
  telemetryTraceHeader,
} from "~/shell/browser-transport/contract";
export { ResourceLimited } from "~/shell/public-http/contract";
export { TelemetryTraceId } from "~/shell/observability/contract";
export { connectionBrowserPaths } from "~/shell/connections/contract";
export const BrowserBootstrapApi = HttpApi.make("BrowserBootstrapApi").add(BrowserSessionGroup);
