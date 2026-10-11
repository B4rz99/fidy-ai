import { useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountConnectionContinuation } from "./program";

/** Mounts connection review with only a public attempt reference from navigation. */
export const ConnectionContinuationFeature = (): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const { attempt } = useSearch({ strict: false });
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback(
    (container: Parameters<RefCallback<HTMLDivElement>>[0]) =>
      container === null
        ? undefined
        : mountConnectionContinuation({ container, attempt, client, resources }),
    [attempt, client, resources]
  );
  return <div id="connection-continuation" ref={mount} />;
};
