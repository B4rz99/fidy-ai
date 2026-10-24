import { useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type RefCallback, useCallback, useState } from "react";
import { BrowserLoginPairingFeature } from "@/features/browser-login/feature";
import { useBrowserLoginPairing } from "@/features/browser-login/pairing-controller";
import { ProviderAuthenticationFeature } from "@/features/provider-authentication/feature";
import { useProviderAuthentication } from "@/features/provider-authentication/controller";
import {
  AccessAction,
  AccessLayout,
  type AccessMethod,
  AccessMethodIcon,
} from "@/ui/components/access";

const LoginMethods = ({
  choose,
}: Readonly<{ choose: (method: AccessMethod) => void }>): JSX.Element => (
  <>
    <div data-access-divider="" aria-hidden="true" />
    <div data-access-methods="">
      <AccessAction kind="alternative" onClick={() => choose("email")}>
        <AccessMethodIcon method="email" />
        Correo verificado
      </AccessAction>
      <AccessAction kind="alternative" onClick={() => choose("whatsapp")}>
        <AccessMethodIcon method="whatsapp" />
        WhatsApp
      </AccessAction>
    </div>
  </>
);

export const LoginPage = (): JSX.Element => {
  const search = useSearch({ from: "/login" });
  const [method, setMethod] = useState<"principal" | "email" | "whatsapp">("principal");
  const pairing = useBrowserLoginPairing();
  const provider = useProviderAuthentication({
    handoffReference: Option.fromUndefinedOr(search.handoff),
  });
  const { mounted: mountPairing } = pairing;
  const { mounted: mountProvider } = provider;
  const mounted = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      const disposePairing = mountPairing(node);
      const disposeProvider = mountProvider(node);
      return (): void => {
        disposePairing?.();
        disposeProvider?.();
      };
    },
    [mountPairing, mountProvider]
  );
  const choose = (next: AccessMethod | "principal"): void => {
    pairing.cancel();
    provider.restart();
    if (next === "google" || next === "microsoft") {
      setMethod("principal");
      provider.start(next, "login", "");
    } else {
      setMethod(next);
      if (next === "whatsapp") pairing.start();
    }
  };
  return (
    <AccessLayout>
      <div ref={mounted}>
        {method === "principal" ? (
          <ProviderAuthenticationFeature
            handoffReference={Option.fromUndefinedOr(search.handoff)}
            authentication={provider}
          >
            {search.handoff === undefined ? <LoginMethods choose={choose} /> : null}
          </ProviderAuthenticationFeature>
        ) : (
          <BrowserLoginPairingFeature
            key={method}
            method={method}
            pairing={pairing}
            choose={choose}
          />
        )}
      </div>
    </AccessLayout>
  );
};
