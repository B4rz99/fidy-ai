import { Outlet, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { AccessRefused, ApplicationShell } from "@/features/signed-in/feature";
import { useSession } from "@/session/session-context";
import { RetainedReviewWorkspace } from "./review-workspace";

/** One application shell survives navigation across independently authorized product routes. */
export const ApplicationFrame = (): JSX.Element => {
  const route = useRouterState({
    select: (state) => {
      if (state.matches.some((match) => match.routeId === "/authenticated")) {
        return "authenticated";
      }
      if (state.matches.some((match) => match.routeId === "/independent-application")) {
        return "independent";
      }
      return "standalone";
    },
  });
  const { authentication } = useSession();
  if (route === "authenticated" && authentication === "expired") return <AccessRefused />;
  if (route === "standalone") return <Outlet />;
  return (
    <ApplicationShell>
      <RetainedReviewWorkspace />
    </ApplicationShell>
  );
};
