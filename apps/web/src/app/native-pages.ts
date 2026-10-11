import { Effect, Option } from "effect";
import { mountElementProgram } from "@/browser/element-program";
import { mountBrowserPairing } from "@/features/browser-login/program";
import { destinationAfterLogin } from "@/features/browser-login/destination";
import { mountProviderAuthentication } from "@/features/provider-authentication/program";
import { mountConnectionContinuation } from "@/features/connections/program";
import { mountOAuthManagement } from "@/features/oauth-connections/management-program";
import { mountOAuthReview } from "@/features/oauth-connections/review-program";
import { mountCLIPairing } from "@/features/pats/pairing-program";
import { mountPATManagement } from "@/features/pats/management-program";
import { mountEmailReplacement } from "@/features/email-replacement/program";
import { mountBackupRecovery } from "@/features/recovery/program";
import { mountRecurringDigest } from "@/features/recurring-digest/program";
import { mountSubscription } from "@/features/subscription/program";
import { makeEnrollmentGateway } from "@/features/subscription/enrollment-gateway";
import { mountTransactions } from "@/features/transactions/program";
import { mountDashboard } from "@/features/dashboard/program";
import { mountHostedAgent } from "@/features/agent/program";
import { mountPublicSite } from "@/features/public-site/native/program";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { pushUrl } from "foldkit/navigation";
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
  switch (route._tag) {
    case "Dashboard":
      return mountDashboard({ container, client, resources, registry: lifetime.registry });
    case "Transactions":
      return mountTransactions({ container, client, resources, registry: lifetime.registry });
    case "PATs":
      return mountPATManagement({ container, client, resources });
    case "Email":
      return mountEmailReplacement({ container, apiClient: client, resources });
    case "Recovery":
      return mountBackupRecovery({
        container,
        apiClient: client,
        resources,
        clipboard: Option.none(),
      });
    case "Recurring":
      return mountRecurringDigest({ container, apiClient: client, resources, id: route.id });
    case "Upgrade":
      return mountSubscription({
        container,
        client,
        resources,
        gateway: makeEnrollmentGateway(lifetime.enrollmentClient),
      });
    default:
      return (): void => undefined;
  }
};
const authPage = (configuration: PageMount): (() => void) => {
  const { container, route, lifetime } = configuration;
  const client = lifetime.webAuthClient;
  const resources = authResources(lifetime);
  switch (route._tag) {
    case "Pair":
      return pairing({ ...configuration, route });
    case "Google":
    case "Microsoft":
      return provider({ ...configuration, route });
    case "Agents":
      return mountOAuthManagement({ container, client, resources, after: route.after });
    case "OAuthReview":
      return mountOAuthReview({
        container,
        client,
        resources,
        requestId: route.requestId,
        redirect: (callback) => window.location.assign(callback),
      });
    case "Connections":
      return mountConnectionContinuation({
        container,
        client,
        resources,
        attempt: Option.getOrUndefined(route.attempt),
      });
    case "CLI":
      return mountCLIPairing({
        container,
        client: lifetime.apiClient,
        resources: apiResources(lifetime),
        code: Option.getOrUndefined(route.cliCode),
      });
    default:
      return authenticatedPage(configuration);
  }
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
