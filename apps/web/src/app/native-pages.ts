import { Effect, Match, Option } from "effect";
import { mountElementProgram } from "@/browser/element-program";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { pushUrl } from "foldkit/navigation";
import { mountDashboardPage, mountLazyFeature } from "./native-dashboard";
import { type AppRoute, publicPage } from "./native-routes";
import { type ApplicationOwner, apiResources, authResources } from "./native-lifetime";

type PageMount = Readonly<{
  container: HTMLElement;
  route: AppRoute;
  lifetime: AuthenticationLifetime;
  owner: ApplicationOwner;
}>;
const pairing = ({
  container,
  route,
  lifetime,
  owner,
}: PageMount & Readonly<{ route: typeof AppRoute.Pair.Type }>): (() => void) =>
  mountLazyFeature({
    container,
    loading: "Cargando acceso…",
    load: () => import("@/features/browser-login/feature"),
    mount: ({ mountBrowserPairing, destinationAfterLogin }) =>
      mountBrowserPairing({
        container,
        client: lifetime.webAuthClient,
        resources: authResources(lifetime),
        providerUrl: Option.match(route.cliCode, {
          onNone: () => "/auth/google",
          onSome: (code) => `/auth/google?cliCode=${encodeURIComponent(code)}`,
        }),
        signedIn: owner.current().authentication === "signed-in",
        authenticated: () => {
          const destination = destinationAfterLogin({
            ...Option.match(route.cliCode, {
              onNone: () => ({}),
              onSome: (cliCode) => ({ cliCode }),
            }),
            ...Option.match(route.oauthRequest, {
              onNone: () => ({}),
              onSome: (oauthRequest) => ({ oauthRequest }),
            }),
            ...Option.match(route.connectionAttempt, {
              onNone: () => ({}),
              onSome: (connectionAttempt) => ({ connectionAttempt }),
            }),
          });
          owner.transition("signed-in");
          Effect.runSync(pushUrl(destination));
        },
        loggedOut: () => owner.transition("signed-out"),
        restart: owner.restart,
      }),
  });
const provider = ({
  container,
  route,
  lifetime,
  owner,
}: PageMount &
  Readonly<{
    route: typeof AppRoute.Google.Type | typeof AppRoute.Microsoft.Type;
  }>): (() => void) =>
  mountLazyFeature({
    container,
    loading: "Cargando acceso…",
    load: () => import("@/features/provider-authentication/feature"),
    mount: ({ mountProviderAuthentication }) =>
      mountProviderAuthentication({
        container,
        configuration: {
          provider: route._tag === "Google" ? "google" : "microsoft",
          handoffReference: route.handoff,
          cliCode: Option.getOrUndefined(route.cliCode),
          webAuthClient: lifetime.webAuthClient,
          resources: authResources(lifetime),
          authenticated: () => owner.transition("signed-in"),
        },
      }),
  });
const subscriptionPage = ({ container, lifetime }: PageMount): (() => void) => {
  const client = lifetime.apiClient;
  const resources = apiResources(lifetime);
  return mountLazyFeature({
    container,
    loading: "Cargando página…",
    load: () => import("@/features/subscription/feature"),
    mount: ({ mountSubscription, makeEnrollmentGateway }) =>
      mountSubscription({
        container,
        registry: lifetime.registry,
        client,
        resources,
        gateway: makeEnrollmentGateway(lifetime.enrollmentClient),
      }),
  });
};
const recurringPage = ({
  container,
  lifetime,
  route,
}: Pick<PageMount, "container" | "lifetime"> &
  Readonly<{ route: typeof AppRoute.Recurring.Type }>): (() => void) =>
  mountLazyFeature({
    container,
    loading: "Cargando página…",
    load: () => import("@/features/recurring-digest/feature"),
    mount: ({ mountRecurringDigest }) =>
      mountRecurringDigest({
        container,
        apiClient: lifetime.apiClient,
        resources: apiResources(lifetime),
        registry: lifetime.registry,
        id: route.id,
      }),
  });
const authenticatedPage = ({ container, route, lifetime, owner }: PageMount): (() => void) => {
  const client = lifetime.apiClient;
  const resources = apiResources(lifetime);
  return Match.value(route).pipe(
    Match.tag("Dashboard", () => mountDashboardPage({ container, lifetime })),
    Match.tag("Transactions", () =>
      mountLazyFeature({
        container,
        loading: "Cargando página…",
        load: () => import("@/features/transactions/feature"),
        mount: ({ mountTransactions }) =>
          mountTransactions({ container, client, resources, registry: lifetime.registry }),
      })
    ),
    Match.tag("Access", (route) =>
      mountLazyFeature({
        container,
        loading: "Cargando accesos…",
        load: () => import("./native-access"),
        mount: ({ mountAccessPage }) =>
          mountAccessPage({ container, lifetime, after: route.after }),
      })
    ),
    Match.tag("Email", () =>
      mountLazyFeature({
        container,
        loading: "Cargando página…",
        load: () => import("@/features/email-replacement/feature"),
        mount: ({ mountEmailReplacement }) =>
          mountEmailReplacement({ container, apiClient: client, resources }),
      })
    ),
    Match.tag("Recovery", () =>
      mountLazyFeature({
        container,
        loading: "Cargando página…",
        load: () => import("@/features/recovery/feature"),
        mount: ({ mountBackupRecovery }) =>
          mountBackupRecovery({
            container,
            apiClient: client,
            resources,
            clipboard: Option.none(),
          }),
      })
    ),
    Match.tag("Recurring", (route) => recurringPage({ container, lifetime, route })),
    Match.tag("Upgrade", () => subscriptionPage({ container, route, lifetime, owner })),
    Match.orElse(() => (): void => undefined)
  );
};
const cliPage = ({
  container,
  lifetime,
  route,
}: PageMount & Readonly<{ route: typeof AppRoute.CLI.Type }>): (() => void) =>
  mountLazyFeature({
    container,
    loading: "Cargando página…",
    load: () => import("@/features/pats/feature"),
    mount: ({ mountCLIPairing }) =>
      mountCLIPairing({
        container,
        client: lifetime.apiClient,
        resources: apiResources(lifetime),
        code: Option.getOrUndefined(route.cliCode),
      }),
  });
const authPage = (configuration: PageMount): (() => void) => {
  const { container, route, lifetime } = configuration;
  const client = lifetime.webAuthClient;
  const resources = authResources(lifetime);
  return Match.value(route).pipe(
    Match.tag("Pair", (route) => pairing({ ...configuration, route })),
    Match.tag("Google", "Microsoft", (route) => provider({ ...configuration, route })),
    Match.tag("OAuthReview", (route) =>
      mountLazyFeature({
        container,
        loading: "Cargando página…",
        load: () => import("@/features/oauth-connections/feature"),
        mount: ({ mountOAuthReview }) =>
          mountOAuthReview({
            container,
            client,
            resources,
            requestId: route.requestId,
            redirect: (callback) => window.location.assign(callback),
          }),
      })
    ),
    Match.tag("Connections", (route) =>
      mountLazyFeature({
        container,
        loading: "Cargando página…",
        load: () => import("@/features/connections/feature"),
        mount: ({ mountConnectionContinuation }) =>
          mountConnectionContinuation({
            container,
            client,
            resources,
            attempt: Option.getOrUndefined(route.attempt),
          }),
      })
    ),
    Match.tag("CLI", (route) => cliPage({ ...configuration, route })),
    Match.orElse(() => authenticatedPage(configuration))
  );
};
/** Embeds one independently scoped feature; only the private owner holds its capabilities. */
export const mountRoutePage = (configuration: PageMount): (() => void) => {
  const page = publicPage(configuration.route);
  return mountElementProgram({
    host: configuration.container,
    mount: (container) =>
      Option.isSome(page)
        ? mountLazyFeature({
            container,
            loading: "Cargando página…",
            load: () => import("@/features/public-site/feature"),
            mount: ({ mountPublicSite }) =>
              mountPublicSite({ container, page: page.value, headOwnership: "Application" }),
          })
        : authPage({ ...configuration, container }),
  });
};
export const mountPersistentAgent = ({
  container,
  lifetime,
}: Readonly<{ container: HTMLElement; lifetime: AuthenticationLifetime }>): (() => void) =>
  mountElementProgram({
    host: container,
    mount: (target) =>
      mountLazyFeature({
        container: target,
        loading: "Cargando agente…",
        load: () => import("@/features/agent/feature"),
        mount: ({ mountHostedAgent }) =>
          mountHostedAgent({
            container: target,
            client: lifetime.hostedTurnClient,
            resources: lifetime.registry.get(lifetime.hostedTurnClient.runtime.layer),
          }),
      }),
  });
