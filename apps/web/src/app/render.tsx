import type { InitialBrowserSession } from "@/transport/initial-session";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installBrowserDefectListeners, reportBrowserDefect } from "@/transport/browser-defects";
import { WebApplication } from "./application";

export { preloadWebRouteCode } from "./routes";

export const mountWebApplication = (root: Element, initial: InitialBrowserSession): void => {
  const disposeDefectListeners = installBrowserDefectListeners(window);
  if (import.meta.env.DEV) import.meta.hot.dispose(disposeDefectListeners);
  createRoot(root, {
    onCaughtError: () => reportBrowserDefect("render_caught"),
    onUncaughtError: () => reportBrowserDefect("render_uncaught"),
    onRecoverableError: () => reportBrowserDefect("render_recoverable"),
  }).render(
    <StrictMode>
      <WebApplication initial={initial} />
    </StrictMode>
  );
};
