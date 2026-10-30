import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { parseApiOrigin } from "@/transport/origin";
import { observeInitialBrowserRequest } from "@/session/initial-request";

export const mountWebApplication = (): void => {
  const ready = Promise.withResolvers<void>();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ready.resolve(), { once: true });
  } else ready.resolve();
  const request = observeInitialBrowserRequest(
    beginInitialBrowserRequest({
      apiOrigin: parseApiOrigin(import.meta.env.VITE_API_ORIGIN),
      context: window.location.pathname.startsWith("/app/"),
      transactions: window.location.pathname === "/app/transactions",
    })
  );
  Promise.all([import("./render"), import("@/transport/initial-session")])
    .then(([{ mountWebApplication, preloadWebRouteCode }, { beginInitialBrowserSession }]) => {
      preloadWebRouteCode().catch(() => undefined);
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
        import("@/transport/browser-defects")
          .then(({ reportBrowserDefect }) => reportBrowserDefect("render_uncaught"))
          .catch(() => undefined);
        const notice = document.createElement("p");
        notice.setAttribute("role", "alert");
        notice.textContent = "No pudimos iniciar la aplicación. Recarga para continuar.";
        root.replaceChildren(notice);
      })
    );
};
