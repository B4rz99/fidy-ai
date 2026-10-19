import { RecurringWorkspace } from "./workspace-components";
import { useMatch, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, Suspense, useState } from "react";
import { useSession } from "@/session/session-context";
import { useWorkspaceResume } from "./workspace-resume";

/** Preserve the visited planning display only inside its current authentication lifetime. */
export const RetainedRecurringWorkspace = (): JSX.Element => {
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  return privacy || authentication === "expired" ? <></> : <VisitedRecurringWorkspace />;
};

const VisitedRecurringWorkspace = (): JSX.Element => {
  const search = Option.fromUndefinedOr(
    useMatch({
      from: "/authenticated/app/recurring",
      shouldThrow: false,
      select: (match) => match.search,
    })
  );
  const [previous, setPrevious] = useState(search);
  if (
    Option.isSome(search) &&
    !Option.exists(
      previous,
      (saved) =>
        saved.month === search.value.month && saved.recurringData === search.value.recurringData
    )
  ) {
    setPrevious(search);
  }
  const current = Option.orElse(search, () => previous);
  const active = Option.isSome(search);
  const resume = useWorkspaceResume({ active, key: "recurring-resume" });
  if (Option.isNone(current)) return <></>;
  return (
    <div hidden={!active} inert={!active} ref={resume}>
      <Suspense fallback={<output>Cargando recurrentes…</output>}>
        <RecurringWorkspace month={Option.fromUndefinedOr(current.value.month)} />
      </Suspense>
    </div>
  );
};
