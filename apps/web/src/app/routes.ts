import {
  ProviderAuthenticationFeature,
  ProviderReturnFeature,
} from "@/features/provider-authentication/feature";
import { Option, Schema } from "effect";
import {
  BudgetMonth,
  ConnectionAttemptReference,
  type FidyClient,
  type HostedTurnClient,
  OAuthConnectionListQuery,
  OAuthRequestId,
  PATPairingPublicCode,
  ProviderHandoffSearch,
  RecurringMonth,
  type WebAuthClient,
} from "@/transport/client";
import { type JSX, createElement } from "react";
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { RouteFailure } from "./route-failure";

type WebRouterContext = Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
type WebRouterOptions = WebRouterContext &
  Readonly<{
    history: Option.Option<RouterHistory>;
  }>;

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
const BrowserLoginPairingFeature = lazyRouteComponent(
  () => import("@/features/browser-login/feature"),
  "BrowserLoginPairingFeature"
);
const EmailReplacementFeature = lazyRouteComponent(
  () => import("@/features/email-replacement/feature"),
  "EmailReplacementFeature"
);
const CLIConnectionFeature = lazyRouteComponent(
  () => import("@/features/pats/feature"),
  "CLIConnectionFeature"
);
const AccessManagementPage = lazyRouteComponent(
  () => import("./access-page"),
  "AccessManagementPage"
);
const BackupRecoveryFeature = lazyRouteComponent(
  () => import("@/features/recovery/feature"),
  "BackupRecoveryFeature"
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

const rootRoute = createRootRouteWithContext<WebRouterContext>()({
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
        createElement(signedIn.SignedInFeature, null, createElement(agent.HostedAgentFeature)),
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
  component: lazyRouteComponent(() => import("@/features/budgets/feature"), "BudgetsFeature"),
});
const createdReviewTransactionRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/needs-review/transactions/$id",
  component: lazyRouteComponent(
    () => import("@/features/needs-review/created-transaction"),
    "CreatedReviewTransaction"
  ),
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
  component: lazyRouteComponent(
    () => import("@/features/needs-review/feature"),
    "NeedsReviewFeature"
  ),
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
  component: lazyRouteComponent(() => import("@/features/recurring/feature"), "RecurringFeature"),
});
const recurringDigestRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/insights/recurring/$id",
  component: RecurringDigestFeature,
});
const patManagementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/pats",
  beforeLoad: () => redirect({ to: "/settings/access", search: {} }),
});
const cliConnectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect/cli",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ cliCode: Schema.optionalKey(PATPairingPublicCode) }))(search),
  component: CLIConnectionFeature,
});
const oauthManagementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/agents",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ after: OAuthConnectionListQuery.fields.after.from }))(search),
  beforeLoad: ({ search }) => redirect({ to: "/settings/access", search }),
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
  component: lazyRouteComponent(() => import("@/features/signed-in/feature"), "ApplicationShell"),
});
const transactionsRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/app/transactions",
  component: TransactionListFeature,
});
const privacyRoute = createRoute({
  getParentRoute: () => independentApplicationRoute,
  path: "/settings/privacy",
  component: lazyRouteComponent(() => import("@/features/privacy/feature"), "PrivacyFeature"),
});
const emailReplacementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/email",
  component: EmailReplacementFeature,
});
const backupRecoveryRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/recovery",
  component: BackupRecoveryFeature,
});
const subscriptionOffersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upgrade",
  component: SubscriptionOffersFeature,
});
const browserLoginPairingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/pair",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        cliCode: Schema.optionalKey(PATPairingPublicCode),
        oauthRequest: Schema.optionalKey(OAuthRequestId),
        connectionAttempt: Schema.optionalKey(ConnectionAttemptReference),
      })
    )(search),
  component: BrowserLoginPairingFeature,
});
const oauthReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
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

const GoogleAuthentication = (): JSX.Element =>
  createElement(ProviderAuthenticationFeature, {
    provider: "google",
    handoffReference: Option.fromUndefinedOr(googleRoute.useSearch().handoff),
  });
const MicrosoftAuthentication = (): JSX.Element =>
  createElement(ProviderAuthenticationFeature, {
    provider: "microsoft",
    handoffReference: Option.fromUndefinedOr(microsoftRoute.useSearch().handoff),
  });

const googleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/google",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        ...ProviderHandoffSearch.fields,
        resume: Schema.optionalKey(Schema.Literal("pat")),
        cliCode: Schema.optionalKey(PATPairingPublicCode),
      })
    )(search),
  component: GoogleAuthentication,
});
const googleReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/google-return",
  component: () => createElement(ProviderReturnFeature, { provider: "google" }),
});
const microsoftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/microsoft",
  validateSearch: (search) =>
    Schema.decodeSync(
      Schema.Struct({
        ...ProviderHandoffSearch.fields,
        resume: Schema.optionalKey(Schema.Literal("pat")),
        cliCode: Schema.optionalKey(PATPairingPublicCode),
      })
    )(search),
  component: MicrosoftAuthentication,
});
const microsoftReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/microsoft-return",
  component: () => createElement(ProviderReturnFeature, { provider: "microsoft" }),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => redirect({ to: "/app/dashboard" }),
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  browserLoginPairingRoute,
  cliConnectionRoute,
  googleRoute,
  googleReturnRoute,
  microsoftRoute,
  microsoftReturnRoute,
  oauthReviewRoute,
  connectionContinuationRoute,
  subscriptionOffersRoute,
  independentApplicationRoute.addChildren([privacyRoute, transactionsRoute]),
  authenticatedRoute.addChildren([
    signedInRoute.addChildren([
      signedInIndexRoute,
      dashboardRoute,
      budgetsRoute,
      recurringPlansRoute,
      needsReviewRoute,
      createdReviewTransactionRoute,
    ]),
    accessManagementRoute,
    patManagementRoute,
    oauthManagementRoute,
    recurringDigestRoute,
    emailReplacementRoute,
    backupRecoveryRoute,
  ]),
]);

export const createWebRouter = (options: WebRouterOptions) =>
  createRouter({
    defaultPreload: "intent",
    defaultPreloadDelay: 0,
    defaultErrorComponent: RouteFailure,
    routeTree,
    context: {
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
