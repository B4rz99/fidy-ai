import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback, useContext } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { mountTransactions } from "./program";

/** Mounts the native workspace in the authentication lifetime's query registry. */
export const TransactionListFeature = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const registry = useContext(RegistryContext);
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) => mountTransactions({ container, client, registry, resources }),
          }),
    [client, registry, resources]
  );
  return <div id="transactions" ref={mount} />;
};
