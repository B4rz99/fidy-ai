import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { useSession } from "@/session/session-context";
import { PATPairingPublicCode } from "@/transport/client";
import { destinationAfterLogin } from "./destination";
import { mountBrowserPairing } from "./program";

/** Mounts the pairing owner for the current authentication lifetime. */
export const BrowserLoginPairingFeature = (): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const resources = useAtomValue(client.runtime.layer);
  const { authentication, completeLogin, completeLogout, replaceAuthenticationLifetime } =
    useSession();
  const cliCode = Schema.decodeUnknownOption(PATPairingPublicCode)(
    router.state.location.search.cliCode
  );
  const providerUrl = Option.match(cliCode, {
    onNone: () => "/auth/google",
    onSome: (code) => `/auth/google?cliCode=${encodeURIComponent(code)}`,
  });
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) =>
              mountBrowserPairing({
                container,
                client,
                resources,
                providerUrl,
                signedIn: authentication === "signed-in",
                authenticated: () => {
                  const href = destinationAfterLogin(router.state.location.search);
                  completeLogin();
                  router.navigate({ href }).catch(() => undefined);
                },
                loggedOut: completeLogout,
                restart: replaceAuthenticationLifetime,
              }),
          }),
    [
      client,
      resources,
      providerUrl,
      authentication,
      completeLogin,
      completeLogout,
      replaceAuthenticationLifetime,
      router,
    ]
  );
  return <div id="browser-pairing" ref={mount} />;
};
