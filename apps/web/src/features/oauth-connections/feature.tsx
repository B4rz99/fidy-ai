import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type RefCallback, useCallback } from "react";
import { ManagementPage } from "./management-feature";
import { mountOAuthReview } from "./review-program";

/** Public pagination references select a scoped Foldkit listing. */
export const OAuthManagementFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const after = Option.fromUndefinedOr(search.after);
  return <ManagementPage key={Option.getOrElse(after, () => "first")} after={after} />;
};
/** Mounts one reviewed request; all interaction belongs to its Foldkit program. */
export const OAuthReviewFeature = (): JSX.Element => {
  const params = useParams({ strict: false });
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const resources = useAtomValue(client.runtime.layer);
  const requestId = params.requestId;
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (container) =>
      container === null
        ? undefined
        : mountOAuthReview({
            container,
            client,
            resources,
            requestId,
            redirect: (callback) => window.location.assign(callback),
          }),
    [client, resources, requestId]
  );
  return <div id="oauth-review" ref={mount} />;
};
