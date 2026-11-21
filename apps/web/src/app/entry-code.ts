import { preloadAgentCode } from "./agent-code";
import { preloadRecurringScreen } from "@/features/recurring/code";
import { preloadSubscriptionScreen } from "@/features/subscription/code";
import { preloadTransactionList } from "@/features/transactions/code";
import { preloadDashboardView } from "@/features/dashboard/code";
import { preloadBudgetScreen } from "@/features/budgets/code";
import { preloadReviewWorkspaceCode } from "@/features/needs-review/code";

const loaded = <A>(promise: Promise<A>): Promise<void> => promise.then(() => undefined);

const entryCode = {
  "/login": (): Promise<void> => loaded(import("./login-page")),
  "/app/transactions": (): Promise<void> =>
    loaded(Promise.all([import("./transactions-page"), preloadTransactionList()])),
  "/app/dashboard": (): Promise<void> =>
    loaded(Promise.all([import("./dashboard-page"), preloadDashboardView()])),
  "/app/needs-review": (): Promise<void> =>
    loaded(Promise.all([import("@/features/needs-review/feature"), preloadReviewWorkspaceCode()])),
  "/app/budgets": (): Promise<void> =>
    loaded(Promise.all([import("@/features/budgets/feature"), preloadBudgetScreen()])),
  "/app/recurring": preloadRecurringScreen,
  "/settings/account": (): Promise<void> => loaded(import("./account-page")),
  "/settings/access": (): Promise<void> => loaded(import("./access-page")),
  "/settings/privacy": (): Promise<void> => loaded(import("@/features/privacy/feature")),
  "/upgrade": preloadSubscriptionScreen,
  "/auth/google-return": (): Promise<void> =>
    loaded(import("@/features/provider-authentication/feature")),
  "/auth/microsoft-return": (): Promise<void> =>
    loaded(import("@/features/provider-authentication/feature")),
} satisfies Readonly<Record<string, () => Promise<void>>>;

const entryCodeByPath = new Map(Object.entries(entryCode));

const preloadEntryCode = (pathname: string): Promise<void> =>
  pathname.startsWith("/oauth/review/")
    ? loaded(import("@/features/oauth-connections/feature"))
    : Promise.resolve(entryCodeByPath.get(pathname)?.());

export const preloadWebRouteCode = (pathname: string): Promise<void> =>
  Promise.allSettled([
    import("./application-frame"),
    preloadEntryCode(pathname),
    preloadAgentCode(pathname),
  ]).then(() => undefined);
