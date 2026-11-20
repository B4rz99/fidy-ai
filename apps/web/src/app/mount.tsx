import { preloadWebRouteCode } from "./entry-code";
import { tryMountProviderReturn } from "./provider-return";
import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { browserApiOrigin } from "@/transport/origin";
import { observeInitialBrowserRequest } from "@/session/initial-request";

export const mountWebApplication = (): void => {
  if (tryMountProviderReturn()) return;
  const ready = Promise.withResolvers<void>();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ready.resolve(), { once: true });
  } else ready.resolve();
  const { pathname } = window.location;
  const transactions = pathname === "/app/transactions";
  const request = observeInitialBrowserRequest(
    beginInitialBrowserRequest({
      apiOrigin: browserApiOrigin({
        configured: import.meta.env.VITE_API_ORIGIN,
        browserOrigin: window.location.origin,
      }),
      context: pathname.startsWith("/app/"),
      transactions,
    })
  );
  const render = import("./render");
  const initialSession = import("@/transport/initial-session").then(
    ({ beginInitialBrowserSession }) => beginInitialBrowserSession({ ...request, request })
  );
  const routeCode = transactions
    ? Promise.all([
        import("./application-frame"),
        import("./bound-application"),
        import("./transactions-page"),
        import("./routes").then(({ preloadTransactionsEntry }) => preloadTransactionsEntry()),
      ]).catch(() => undefined)
    : undefined;
  if (!transactions) preloadWebRouteCode(pathname).catch(() => undefined);
  Promise.all([render, initialSession, routeCode])
    .then(([{ mountWebApplication }, initial]) =>
      ready.promise.then(() => {
        const root = document.querySelector("#root");
        if (root === null) throw new Error("Web application root is missing");
        mountWebApplication({ root, initial });
      })
    )
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
