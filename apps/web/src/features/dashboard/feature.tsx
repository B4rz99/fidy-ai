import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type JSX, type RefCallback, useCallback, useContext } from "react";
import { mountElementProgram } from "@/browser/element-program";
import type { FidyClient } from "@/transport/client";
import { mountDashboard } from "./program";

/** Mounts the native Dashboard in the authentication lifetime's query registry. */
export const DashboardFeature = ({
  apiClient,
}: Readonly<{ apiClient: FidyClient }>): JSX.Element => {
  const registry = useContext(RegistryContext);
  const resources = useAtomValue(apiClient.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) =>
              mountDashboard({ container, client: apiClient, registry, resources }),
          }),
    [apiClient, registry, resources]
  );
  return <div id="dashboard" ref={mount} />;
};
