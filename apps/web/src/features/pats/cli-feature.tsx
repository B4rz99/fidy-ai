import { useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { mountCLIPairing } from "./pairing-program";

/** Mounts the scoped CLI approval program for one public code. */
export const CLIConnectionFeature = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const resources = useAtomValue(client.runtime.layer);
  const { cliCode: code } = useSearch({ strict: false });
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) => mountCLIPairing({ container, client, resources, code }),
          }),
    [client, resources, code]
  );
  return <div id="cli-connection" ref={mount} />;
};
