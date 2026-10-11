import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountRecurringDigest } from "./program";

/** Mounts the report identified by navigation inside the current authentication lifetime. */
export const RecurringDigestFeature = (): JSX.Element => {
  const { id } = useParams({ strict: false });
  const apiClient = useRouter().options.context.apiClient;
  const resources = useAtomValue(apiClient.runtime.layer);
  const mount = useCallback(
    (container: Parameters<RefCallback<HTMLDivElement>>[0]) =>
      container === null
        ? undefined
        : mountRecurringDigest({ container, apiClient, resources, id }),
    [apiClient, resources, id]
  );
  return <div id="recurring-digest" ref={mount} />;
};
