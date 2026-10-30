import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { parseApiOrigin } from "@/transport/origin";
import { observeInitialBrowserRequest } from "@/session/initial-request";

export const mountWebApplication = (): void => {
  const documentReady =
    document.readyState === "loading"
      ? new Promise<void>((resolve) =>
          document.addEventListener("DOMContentLoaded", () => resolve(), { once: true })
        )
      : Promise.resolve();
  const request = observeInitialBrowserRequest(
    beginInitialBrowserRequest(
      parseApiOrigin(import.meta.env.VITE_API_ORIGIN),
      window.location.pathname.startsWith("/app/"),
      window.location.pathname === "/app/transactions"
    )
  );
  Promise.all([import("./render"), import("@/transport/initial-session")])
    .then(
      async ([{ mountWebApplication, preloadWebRouteCode }, { beginInitialBrowserSession }]) => {
        preloadWebRouteCode().catch(() => undefined);
        const initial = beginInitialBrowserSession({ ...request, request });
        await documentReady;
        const root = document.querySelector("#root");
        if (root === null) throw new Error("Web application root is missing");
        mountWebApplication(root, initial);
      }
    )
    .catch(async () => {
      await documentReady;
      const root = document.querySelector("#root") ?? document.body;
      request.cancel();
      import("@/transport/browser-defects")
        .then(({ reportBrowserDefect }) => reportBrowserDefect("render_uncaught"))
        .catch(() => undefined);
      const notice = document.createElement("p");
      notice.setAttribute("role", "alert");
      notice.textContent = "No pudimos iniciar la aplicación. Recarga para continuar.";
      root.replaceChildren(notice);
    });
};
