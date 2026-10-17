import { useWorkspaceResume } from "./workspace-resume";
import { useMatch, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { useSession } from "@/session/session-context";
import { type JSX, Suspense, lazy, memo, useState } from "react";

const ReviewWorkspace = lazy(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: memo(module.NeedsReviewFeature),
  }))
);

/** Keep the visited inbox in its authentication lifetime, including its evidence expiry timers. */
export const RetainedReviewWorkspace = (): JSX.Element => {
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  return privacy || authentication === "expired" ? <></> : <VisitedReviewWorkspace />;
};
const VisitedReviewWorkspace = (): JSX.Element => {
  const search = Option.fromUndefinedOr(
    useMatch({
      from: "/authenticated/app/needs-review",
      shouldThrow: false,
      select: (match) => match.search,
    })
  );
  const [previous, setPrevious] = useState(search);
  if (Option.isSome(search)) {
    const next = search.value;
    if (
      !Option.exists(
        previous,
        (saved) => saved.status === next.status && saved.offset === next.offset
      )
    ) {
      setPrevious(search);
    }
  }
  const current = Option.orElse(search, () => previous);
  const active = Option.isSome(search);
  const resume = useWorkspaceResume({ active, key: "ingestion-review" });
  if (Option.isNone(current)) return <></>;
  return (
    <div hidden={!active} inert={!active} ref={resume}>
      <Suspense fallback={<p className="p-5">Cargando elementos…</p>}>
        <ReviewWorkspace
          active={true}
          filter={current.value.status ?? "pending"}
          page={current.value.offset ?? 0}
        />
      </Suspense>
    </div>
  );
};
