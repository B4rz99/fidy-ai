import { Outlet, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { HostedAgentFeature } from "@/features/agent/feature";
import { SignedInContent } from "@/features/signed-in/feature";

export const AuthenticatedRoute = (): JSX.Element => {
  const checkingConsent = useRouterState({
    select: (state) =>
      state.status === "pending" && state.location.pathname === "/app/transactions",
  });

  return (
    <SignedInContent>
      <Outlet />
      {checkingConsent ? null : <HostedAgentFeature />}
    </SignedInContent>
  );
};
