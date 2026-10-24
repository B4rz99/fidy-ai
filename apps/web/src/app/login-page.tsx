import { useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import {
  BrowserLoginPairingFeature,
  type BrowserLoginPresentation,
} from "@/features/browser-login/feature";
import {
  ProviderAuthenticationFeature,
  type ProviderAuthenticationPresentation,
} from "@/features/provider-authentication/feature";
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
const AccessMethods = ({
  pairing,
  provider,
  hasHandoff,
}: Readonly<{
  pairing: BrowserLoginPresentation;
  provider: ProviderAuthenticationPresentation;
  hasHandoff: boolean;
}>): JSX.Element => {
  const [method, setMethod] = useState<"principal" | "email" | "whatsapp">("principal");
  const choose = (next: AccessMethod | "principal"): void => {
    pairing.cancel();
    provider.restart();
    if (next === "google" || next === "microsoft") {
      setMethod("principal");
      provider.startLogin(next);
    } else {
      setMethod(next);
      if (next === "whatsapp") pairing.start();
    }
  };
  return method === "principal"
    ? provider.render(hasHandoff ? null : <LoginMethods choose={choose} />)
    : pairing.render(method, choose);
};
export const LoginPage = (): JSX.Element => {
  const search = useSearch({ from: "/login" });
  return (
    <AccessLayout>
      <BrowserLoginPairingFeature>
        {(pairing) => (
          <ProviderAuthenticationFeature handoffReference={Option.fromUndefinedOr(search.handoff)}>
            {(provider) => (
              <AccessMethods
                pairing={pairing}
                provider={provider}
                hasHandoff={search.handoff !== undefined}
              />
            )}
          </ProviderAuthenticationFeature>
        )}
      </BrowserLoginPairingFeature>
    </AccessLayout>
  );
};
