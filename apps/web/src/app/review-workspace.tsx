import { useAtomSet } from "@effect/atom-react";
import { useMatch, useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { Reactivity } from "effect/reactivity";
import { useSession } from "@/session/session-context";
import { type JSX, type RefCallback, Suspense, lazy, useCallback, useRef, useState } from "react";

const ReviewWorkspace = lazy(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: module.NeedsReviewFeature,
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
  const resume = useReviewResume(active);
  if (Option.isNone(current)) return <></>;
  return (
    <div hidden={!active} ref={resume}>
      <Suspense fallback={<p className="p-5">Cargando elementos…</p>}>
        <ReviewWorkspace
          active={active}
          filter={current.value.status ?? "pending"}
          page={current.value.offset ?? 0}
        />
      </Suspense>
    </div>
  );
};

const useReviewResume = (active: boolean): RefCallback<HTMLDivElement> => {
  const apiClient = useRouter().options.context.apiClient;
  const [operation] = useState(() =>
    apiClient.runtime.fn<void>()(() => Reactivity.invalidate(["ingestion-review"]))
  );
  const refresh = useAtomSet(operation);
  const visibility = useRef({ active, visited: false });
  return useCallback(
    (node) => {
      if (node === null) return;
      const returning = active && visibility.current.visited && !visibility.current.active;
      visibility.current = { active, visited: true };
      if (returning) {
        queueMicrotask(() => {
          if (node.isConnected && node.hidden === false) refresh();
        });
      }
    },
    [active, refresh]
  );
};
