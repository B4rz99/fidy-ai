import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import type { Option } from "effect";
import { type JSX, type RefCallback, useCallback } from "react";
import type { OAuthConnectionId } from "@/transport/client";
import { mountOAuthManagement } from "./management-program";

/** Mounts the scoped Foldkit listing for one public pagination cursor. */
export const ManagementPage = ({
  after,
}: Readonly<{ after: Option.Option<OAuthConnectionId> }>): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const resources = useAtomValue(client.runtime.layer);
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (container) =>
      container === null
        ? undefined
        : mountOAuthManagement({ container, client, resources, after }),
    [client, resources, after]
  );
  return <div id="oauth-management" ref={mount} />;
};
