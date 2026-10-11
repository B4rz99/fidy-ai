import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback, useState } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { useSubscriptionEnrollmentClient } from "@/session/subscription-enrollment-context";
import { makeEnrollmentGateway } from "./enrollment-gateway";
import { mountSubscription } from "./program";

/** Mounts subscription offers and private payment work for this authentication lifetime. */
export const SubscriptionOffersFeature = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const enrollmentClient = useSubscriptionEnrollmentClient();
  const [gateway] = useState(() => makeEnrollmentGateway(enrollmentClient));
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) => mountSubscription({ container, client, resources, gateway }),
          }),
    [client, resources, gateway]
  );
  return <div id="subscription" ref={mount} />;
};
