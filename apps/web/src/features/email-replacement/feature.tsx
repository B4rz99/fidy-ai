import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountEmailReplacement } from "./program";

/** Mounts the scoped email replacement program within the current application route. */
export const EmailReplacementFeature = (): JSX.Element => {
  const router = useRouter();
  const apiClient = router.options.context.apiClient;
  const resources = useAtomValue(apiClient.runtime.layer);
  const mount = useCallback(
    (element: Parameters<RefCallback<HTMLDivElement>>[0]) =>
      element === null
        ? undefined
        : mountEmailReplacement({
            container: element,
            apiClient,
            resources,
          }),
    [apiClient, resources]
  );
  return <div id="email-replacement" ref={mount} />;
};
