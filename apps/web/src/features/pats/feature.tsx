import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { mountPATManagement } from "./management-program";

/** Mounts token management for the current authentication lifetime. */
export const PATManagementFeature = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) => mountPATManagement({ container, client, resources }),
          }),
    [client, resources]
  );
  return <div id="pat-management" ref={mount} />;
};
export { CLIConnectionFeature } from "./cli-feature";
