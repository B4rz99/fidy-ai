import { destinationAfterLogin, mountBrowserPairing } from "@/features/browser-login/feature";
import { mountProviderAuthentication } from "@/features/provider-authentication/feature";
import { mountConnectionContinuation } from "@/features/connections/feature";
import { mountOAuthManagement, mountOAuthReview } from "@/features/oauth-connections/feature";
import { mountCLIPairing, mountPATManagement } from "@/features/pats/feature";
import { mountEmailReplacement } from "@/features/email-replacement/feature";
import { mountBackupRecovery } from "@/features/recovery/feature";
import { mountRecurringDigest } from "@/features/recurring-digest/feature";
import { makeEnrollmentGateway, mountSubscription } from "@/features/subscription/feature";
import { mountTransactions } from "@/features/transactions/feature";
import { mountHostedAgent } from "@/features/agent/feature";
import { mountPublicSite } from "@/features/public-site/feature";
import { Effect, Match, Option } from "effect";
import { mountElementProgram } from "@/browser/element-program";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { pushUrl } from "foldkit/navigation";
import { mountDashboardPage } from "./native-dashboard";
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
        ...Option.match(route.cliCode, { onNone: () => ({}), onSome: (cliCode) => ({ cliCode }) }),
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
  });
const authenticatedPage = ({ container, route, lifetime }: PageMount): (() => void) => {
  const client = lifetime.apiClient;
  const resources = apiResources(lifetime);
  return Match.value(route).pipe(
    Match.tag("Dashboard", () => mountDashboardPage({ container, lifetime })),
    Match.tag("Transactions", () =>
      mountTransactions({ container, client, resources, registry: lifetime.registry })
    ),
    Match.tag("PATs", () => mountPATManagement({ container, client, resources })),
    Match.tag("Email", () => mountEmailReplacement({ container, apiClient: client, resources })),
    Match.tag("Recovery", () =>
      mountBackupRecovery({
        container,
        apiClient: client,
        resources,
        clipboard: Option.none(),
      })
    ),
    Match.tag("Recurring", (route) =>
      mountRecurringDigest({ container, apiClient: client, resources, id: route.id })
    ),
    Match.tag("Upgrade", () =>
      mountSubscription({
        container,
        client,
        resources,
        gateway: makeEnrollmentGateway(lifetime.enrollmentClient),
      })
    ),
    Match.orElse(() => (): void => undefined)
  );
};
const authPage = (configuration: PageMount): (() => void) => {
  const { container, route, lifetime } = configuration;
  const client = lifetime.webAuthClient;
  const resources = authResources(lifetime);
  return Match.value(route).pipe(
    Match.tag("Pair", (route) => pairing({ ...configuration, route })),
    Match.tag("Google", "Microsoft", (route) => provider({ ...configuration, route })),
    Match.tag("Agents", (route) =>
      mountOAuthManagement({ container, client, resources, after: route.after })
    ),
    Match.tag("OAuthReview", (route) =>
      mountOAuthReview({
        container,
        client,
        resources,
        requestId: route.requestId,
        redirect: (callback) => window.location.assign(callback),
      })
    ),
    Match.tag("Connections", (route) =>
      mountConnectionContinuation({
        container,
        client,
        resources,
        attempt: Option.getOrUndefined(route.attempt),
      })
    ),
    Match.tag("CLI", (route) =>
      mountCLIPairing({
        container,
        client: lifetime.apiClient,
        resources: apiResources(lifetime),
        code: Option.getOrUndefined(route.cliCode),
      })
    ),
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
        ? mountPublicSite({ container, page: page.value, headOwnership: "Application" })
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
      mountHostedAgent({
        container: target,
        client: lifetime.hostedTurnClient,
        resources: lifetime.registry.get(lifetime.hostedTurnClient.runtime.layer),
      }),
  });
