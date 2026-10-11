import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { mountHostedAgent } from "./program";

/** Keeps the conversation runtime mounted across authenticated route changes. */
export const HostedAgentFeature = (): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (container) =>
      container === null
        ? undefined
        : mountElementProgram({
            host: container,
            mount: (target) => mountHostedAgent({ container: target, client, resources }),
          }),
    [client, resources]
  );
  return <div id="hosted-agent" ref={mount} />;
};
