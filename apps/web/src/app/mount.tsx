import { preloadWebRouteCode } from "./entry-code";
import { tryMountProviderReturn } from "./provider-return";
import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { browserApiOrigin } from "@/transport/origin";
import { observeInitialBrowserRequest } from "@/session/initial-request";

const reportStartupDefect = (error: "preparation_failed" | "render_uncaught"): void => {
  import("@/transport/browser-defects")
    .then(({ reportBrowserDefect }) => reportBrowserDefect(error))
    .catch(() => undefined);
};

export const mountWebApplication = (): void => {
  if (tryMountProviderReturn()) return;
  const ready = Promise.withResolvers<void>();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ready.resolve(), { once: true });
  } else ready.resolve();

  const request = observeInitialBrowserRequest(
    beginInitialBrowserRequest({
      apiOrigin: browserApiOrigin({
        configured: import.meta.env.VITE_API_ORIGIN,
        browserOrigin: window.location.origin,
      }),
      context: window.location.pathname.startsWith("/app/"),
      transactions: window.location.pathname === "/app/transactions",
    })
  );

  preloadWebRouteCode(window.location.pathname).catch(() =>
    reportStartupDefect("preparation_failed")
  );
  Promise.all([import("./render"), import("@/transport/initial-session")])
    .then(([{ mountWebApplication }, { beginInitialBrowserSession }]) => {
      const initial = beginInitialBrowserSession({ ...request, request });

      return ready.promise.then(() => {
        const root = document.querySelector("#root");

        if (root === null) throw new Error("Web application root is missing");
        mountWebApplication({ root, initial });
      });
    })
    .catch(() =>
      ready.promise.then(() => {
        const root = document.querySelector("#root") ?? document.body;
        request.cancel();
        reportStartupDefect("render_uncaught");
        const notice = document.createElement("p");
        notice.setAttribute("role", "alert");
        notice.textContent = "No pudimos iniciar la aplicación. Recarga para continuar.";
        root.replaceChildren(notice);
      })
    );
};
