import { preloadTransactionList } from "@/features/transactions/code";

const entryCode: Readonly<Record<string, () => Promise<unknown>>> = {
  "/login": () => import("./login-page"),
  "/app/transactions": () => Promise.all([import("./transactions-page"), preloadTransactionList()]),
  "/app/dashboard": () => import("./dashboard-page"),
  "/app/needs-review": () =>
    import("@/features/needs-review/feature").then((module) => module.NeedsReviewFeature.preload()),
  "/app/budgets": () =>
    import("@/features/budgets/feature").then((module) => module.BudgetsFeature.preload()),
  "/app/recurring": () => import("@/features/recurring/feature"),
  "/settings/account": () => import("./account-page"),
  "/settings/access": () => import("./access-page"),
  "/settings/privacy": () => import("@/features/privacy/feature"),
  "/upgrade": () => import("@/features/subscription/feature"),
  "/auth/google-return": () => import("@/features/provider-authentication/feature"),
  "/auth/microsoft-return": () => import("@/features/provider-authentication/feature"),
};
const preloadEntryCode = (pathname: string): Promise<unknown> =>
  pathname.startsWith("/oauth/review/")
    ? import("@/features/oauth-connections/feature")
    : Promise.resolve(entryCode[pathname]?.());

/** Code loading starts alongside the native binding request; no client or data read starts here. */
export const preloadWebRouteCode = (pathname: string): Promise<void> =>
  Promise.allSettled([import("./application-frame"), preloadEntryCode(pathname)]).then(
    () => undefined
  );
