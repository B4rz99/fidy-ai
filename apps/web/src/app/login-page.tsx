import { useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { BrowserLoginPairingFeature } from "@/features/browser-login/feature";
import { ProviderAuthenticationFeature } from "@/features/provider-authentication/feature";
import { Button } from "@/ui/components/button";

export const LoginPage = (): JSX.Element => {
  const search = useSearch({ from: "/login" });
  const [method, setMethod] = useState<"provider" | "pairing">("provider");
  return method === "pairing" ? (
    <BrowserLoginPairingFeature onChooseProvider={() => setMethod("provider")} />
  ) : (
    <ProviderAuthenticationFeature handoffReference={Option.fromUndefinedOr(search.handoff)}>
      {search.handoff === undefined ? (
        <Button variant="ghost" onClick={() => setMethod("pairing")}>
          WhatsApp o correo verificado
        </Button>
      ) : null}
    </ProviderAuthenticationFeature>
  );
};
