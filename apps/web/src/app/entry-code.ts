import { preloadTransactionList } from "@/features/transactions/code";
import { preloadDashboardView } from "@/features/dashboard/code";
import { preloadBudgetScreen } from "@/features/budgets/code";
import { preloadReviewWorkspaceCode } from "@/features/needs-review/code";

const entryCode: Readonly<Record<string, () => Promise<unknown>>> = {
  "/login": () => import("./login-page"),
  "/app/transactions": () => Promise.all([import("./transactions-page"), preloadTransactionList()]),
  "/app/dashboard": () => Promise.all([import("./dashboard-page"), preloadDashboardView()]),
  "/app/needs-review": () =>
    Promise.all([import("@/features/needs-review/feature"), preloadReviewWorkspaceCode()]),
  "/app/budgets": () => Promise.all([import("@/features/budgets/feature"), preloadBudgetScreen()]),
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
