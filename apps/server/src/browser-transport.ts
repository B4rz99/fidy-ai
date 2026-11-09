/** Dependency-free browser request declarations; response codecs live in browser-bootstrap. */
export {
  browserSessionBindingPath,
  browserSessionBindingHeader,
  telemetryTraceHeader,
  telemetryTraceIdPatternSource,
  connectionBrowserPaths,
} from "~/shell/browser-transport/contract";
export { isHttpOrigin } from "~/shell/browser-transport/operations";
