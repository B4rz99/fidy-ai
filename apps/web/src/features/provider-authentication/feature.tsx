import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type RefCallback, useCallback } from "react";
import { useSession } from "@/session/session-context";
import type { AuthenticationProvider } from "@/transport/client";
import { mountProviderAuthentication } from "./program";

/** The React route owns mounting only; Foldkit owns authentication presentation and commands. */
export const ProviderAuthenticationFeature = ({
  provider,
  handoffReference,
}: Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>): JSX.Element => {
  const router = useRouter();
  const { completeLogin } = useSession();
  const webAuthClient = router.options.context.webAuthClient;
  const resources = useAtomValue(webAuthClient.runtime.layer);
  const handoff = Option.getOrUndefined(handoffReference);
  const cliCode = router.state.location.search.cliCode;
  const mounted = useCallback(
    (node: Parameters<RefCallback<HTMLDivElement>>[0]) =>
      node === null
        ? undefined
        : mountProviderAuthentication({
            container: node,
            configuration: {
              provider,
              handoffReference: Option.fromUndefinedOr(handoff),
              cliCode,
              webAuthClient,
              resources,
              authenticated: completeLogin,
            },
          }),
    [provider, handoff, cliCode, webAuthClient, resources, completeLogin]
  );
  return <div id="provider-authentication" ref={mounted} />;
};

const closeProviderReturn = (node: Parameters<RefCallback<HTMLElement>>[0]): void => {
  if (node !== null) window.close();
};

/** The parameter-free callback page closes the popup without repeating authentication. */
export const ProviderReturnFeature = ({
  provider,
}: Readonly<{ provider: AuthenticationProvider }>): JSX.Element => (
  <main ref={closeProviderReturn}>
    <p>Puedes volver a la ventana de Fidy para continuar.</p>
    <a href={`/auth/${provider}`}>Iniciar sesión</a>
  </main>
);
