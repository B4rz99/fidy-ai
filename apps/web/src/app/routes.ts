import { AsyncResult } from "effect/reactivity";
import { BudgetRoute, RecurringRoute } from "./destination-components";
import { prepareQuery } from "@/transport/query-preparation";
import { consumeInitialTransactionConsent, transactionEntryConsent } from "./transaction-entry";
import { RecurringWorkspace, ReviewWorkspace } from "./workspace-components";
import { NeedsReviewRoute } from "@/features/needs-review/feature";
import { LoginSearch } from "@/session/login-destination";
import type { AtomRegistry } from "effect/reactivity";
import { Option, Schema } from "effect";
import {
  BudgetMonth,
  type FidyClient,
  type HostedTurnClient,
  OAuthConnectionListQuery,
  PATPairingPublicCode,
  RecurringMonth,
  type WebAuthClient,
} from "@/transport/client";
import { type JSX, createElement } from "react";
import {
  Outlet,
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { RouteFailure } from "./route-failure";

type WebRouterContext = Readonly<{
  registry: AtomRegistry.AtomRegistry;
  /** Display identity already checked by BrowserSessionBoundary; never grants authority. */
  sessionBinding: string;
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
type WebRouterOptions = WebRouterContext &
  Readonly<{
    history: Option.Option<RouterHistory>;
  }>;

const ProviderReturnFeature = lazyRouteComponent(
  () => import("@/features/provider-authentication/feature"),
  "ProviderReturnFeature"
);

const RecurringDigestFeature = lazyRouteComponent(
  () => import("@/features/recurring-digest/feature"),
  "RecurringDigestFeature"
);
const ConnectionContinuationFeature = lazyRouteComponent(
  () => import("@/features/connections/feature"),
  "ConnectionContinuationFeature"
);
const OAuthReviewFeature = lazyRouteComponent(
  () => import("@/features/oauth-connections/feature"),
  "OAuthReviewFeature"
);
const CLIConnectionFeature = lazyRouteComponent(
  () => import("@/features/pats/feature"),
  "CLIConnectionFeature"
);
const AccessManagementPage = lazyRouteComponent(
  () => import("./access-page"),
  "AccessManagementPage"
);
const SubscriptionOffersFeature = lazyRouteComponent(
  () => import("@/features/subscription/feature"),
  "SubscriptionOffersFeature"
);
const TransactionListFeature = lazyRouteComponent(
  () => import("./transactions-page"),
  "TransactionsPage"
);

const DashboardRoute = lazyRouteComponent(() => import("./dashboard-page"), "DashboardPage");

const ApplicationFrame = lazyRouteComponent(
  () => import("./application-frame"),
  "ApplicationFrame"
);
const rootRoute = createRootRouteWithContext<WebRouterContext>()({
  component: ApplicationFrame,
  notFoundComponent: () =>
    createElement(
      "main",
      { className: "p-8" },
      createElement("h1", null, "Página no encontrada"),
      createElement("a", { href: "https://fidyapp.com" }, "Volver al inicio")
    ),
});
const AuthenticatedRoute = lazyRouteComponent(() =>
  Promise.all([import("@/features/signed-in/feature"), import("@/features/agent/feature")]).then(
    ([signedIn, agent]) => ({
      default: (): JSX.Element =>
        createElement(
          signedIn.SignedInContent,
          null,
          createElement(Outlet),
          createElement(agent.HostedAgentFeature)
        ),
    })
  )
);
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: AuthenticatedRoute,
});
const signedInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/app",
});
const signedInIndexRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/",
  beforeLoad: () => redirect({ to: "/app/dashboard" }),
});
const dashboardRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/dashboard",
  component: DashboardRoute,
});
const budgetsRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/budgets",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        month: Schema.optionalKey(BudgetMonth),
        data: Schema.optionalKey(
          Schema.Literals(["demo", "worst", "empty", "one", "full", "many"])
        ),
      })
    )(search),
  loaderDeps: ({ search }) => ({ month: search.month }),
  loader: async ({ context, deps, abortController }) => {
    const { BudgetsFeature } = await import("@/features/budgets/feature");
    await Promise.all([
      BudgetsFeature.preload(),
      BudgetsFeature.preloadData({
        apiClient: context.apiClient,
        registry: context.registry,
        month: Option.fromUndefinedOr(deps.month),
        signal: Option.some(abortController.signal),
      }),
    ]);
  },
  component: BudgetRoute,
});
const needsReviewRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/needs-review",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        status: Schema.optionalKey(
          Schema.Literals(["pending", "history", "created", "skipped", "expired"])
        ),
        offset: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
        ),
      })
    )(search),
  preloadStaleTime: 0,
  loaderDeps: ({ search }) => ({ filter: search.status ?? "pending", page: search.offset ?? 0 }),
  loader: {
    staleReloadMode: "blocking",
    handler: async ({ context, deps, preload, abortController }) => {
      await Promise.all([
        ReviewWorkspace.preload(),
        preload
          ? Promise.resolve()
          : ReviewWorkspace.preloadData({
              apiClient: context.apiClient,
              registry: context.registry,
              filter: deps.filter,
              page: deps.page,
              signal: abortController.signal,
            }),
      ]);
    },
  },
  component: NeedsReviewRoute,
});
const recurringPlansRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/recurring",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        month: Schema.optionalKey(RecurringMonth),
        recurringData: Schema.optionalKey(
          Schema.Literals(["demo", "worst", "empty", "one", "many", "stale"])
        ),
      })
    )(search),
  loaderDeps: ({ search }) => ({ month: search.month }),
  preloadStaleTime: 0,
  loader: async ({ context, deps, preload, abortController }) => {
    await RecurringWorkspace.preload?.();
    const { RecurringRoute } = await import("@/features/recurring/feature");
    await RecurringRoute.preloadData({
      apiClient: context.apiClient,
      registry: context.registry,
      month: Option.fromUndefinedOr(deps.month),
      signal: abortController.signal,
      intent: preload,
    });
  },
  component: RecurringRoute,
});
const recurringDigestRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/insights/recurring/$id",
  component: RecurringDigestFeature,
});
const cliConnectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect/cli",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ cliCode: Schema.optionalKey(PATPairingPublicCode) }))(search),
  component: CLIConnectionFeature,
});
const accessManagementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/access",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        resume: Schema.optionalKey(Schema.Literal("pat")),
        after: OAuthConnectionListQuery.fields.after.from,
      })
    )(search),
  component: AccessManagementPage,
});
const independentApplicationRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "independent-application",
});
const transactionsRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/app/transactions",
  // A speculative loader must never donate a code-only result to an actual Consent entry.
  preload: false,
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: async ({ context, preload, abortController }) => {
      await TransactionListFeature.preload?.();
      if (!preload) {
        const consent = transactionEntryConsent(context.webAuthClient);
        const initial = consumeInitialTransactionConsent(context.registry);
        await prepareQuery(context.registry, consent, {
          mode: initial ? "cached" : "fresh",
          signal: Option.some(abortController.signal),
        });
        const status = context.registry.get(consent);
        if (AsyncResult.isSuccess(status) && !status.waiting && status.value.status === "Granted") {
          const { TransactionsPage } = await import("./transactions-page");
          await TransactionsPage.preloadData({
            apiClient: context.apiClient,
            registry: context.registry,
            signal: abortController.signal,
          });
        }
      }
    },
  },
  component: TransactionListFeature,
});
const privacyRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/settings/privacy",
  component: lazyRouteComponent(() => import("@/features/privacy/feature"), "PrivacyFeature"),
});
const subscriptionOffersRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/upgrade",
  component: SubscriptionOffersFeature,
});
const oauthReviewRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/oauth/review/$requestId",
  component: OAuthReviewFeature,
});
const connectionContinuationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections/continue",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ attempt: Schema.optionalKey(Schema.Unknown) }))(search),
  component: ConnectionContinuationFeature,
});
const connectionResultRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/connections/result",
  component: lazyRouteComponent(
    () => import("@/features/connections/feature"),
    "ConnectionResultFeature"
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search) => Schema.decodeSync(LoginSearch)(search),
  component: lazyRouteComponent(() => import("./login-page"), "LoginPage"),
});
const accountRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/account",
  component: lazyRouteComponent(() => import("./account-page"), "AccountPage"),
});
const googleReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/google-return",
  component: ProviderReturnFeature,
});
const microsoftReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/microsoft-return",
  component: ProviderReturnFeature,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => redirect({ to: "/app/dashboard" }),
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  cliConnectionRoute,
  googleReturnRoute,
  microsoftReturnRoute,
  connectionContinuationRoute,
  independentApplicationRoute.addChildren([
    connectionResultRoute,
    oauthReviewRoute,
    privacyRoute,
    transactionsRoute,
    subscriptionOffersRoute,
  ]),
  authenticatedRoute.addChildren([
    signedInRoute.addChildren([
      signedInIndexRoute,
      dashboardRoute,
      budgetsRoute,
      recurringPlansRoute,
      needsReviewRoute,
    ]),
    accessManagementRoute,
    accountRoute,
    recurringDigestRoute,
  ]),
]);

export const createWebRouter = (options: WebRouterOptions) =>
  createRouter({
    defaultPreload: "intent",
    defaultPreloadDelay: 0,
    defaultErrorComponent: RouteFailure,
    routeTree,
    context: {
      registry: options.registry,
      sessionBinding: options.sessionBinding,
      apiClient: options.apiClient,
      webAuthClient: options.webAuthClient,
      hostedTurnClient: options.hostedTurnClient,
    },
    history: Option.getOrUndefined(options.history),
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}

/** Only the shell and entry code compete with initial identity and foreground work. */
export const preloadWebRouteCode = async (): Promise<void> => {
  await Promise.allSettled([ApplicationFrame.preload?.(), TransactionListFeature.preload?.()]);
};
