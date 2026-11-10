import { useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type ReactNode } from "react";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { type BrowserAuthentication, useSession } from "@/session/session-context";
import { type FidyClient } from "@/transport/client";
import { sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { RefreshButton } from "@/ui/components/refresh-button";
import { ManualPATCreation } from "./creation";
import { usePATManagement } from "./management";
import { type ActivePATManagementState, ActivePATManagementView } from "./management-view";

type PATManagementContentProps = Readonly<{
  children: (
    content: Readonly<{ tokens: ReactNode; creation: ReactNode; refresh: ReactNode }>
  ) => ReactNode;
  refreshPATs: () => void;
  refreshing: boolean;
  activePATState: ActivePATManagementState;
  authentication: BrowserAuthentication;
  apiClient: FidyClient;
  resuming: boolean;
  management: ReturnType<typeof usePATManagement>;
}>;

const PATManagementContent = ({
  children,
  activePATState,
  refreshPATs,
  refreshing,
  authentication,
  apiClient,
  resuming,
  management,
}: PATManagementContentProps): JSX.Element => (
  <SensitiveClipboardBoundary
    className={Option.some("min-w-0")}
    key={authentication}
    lifetime={sensitiveClipboardLifetime}
  >
    {(clipboard) =>
      children({
        refresh: (
          <RefreshButton
            disabled={refreshing}
            label="Actualizar tokens"
            onClick={refreshPATs}
            type="button"
          />
        ),
        tokens: (
          <ActivePATManagementView
            state={activePATState}
            task={management.task}
            actions={management.actions}
            lifecycleRef={management.lifecycleRef}
          />
        ),
        creation: (
          <ManualPATCreation apiClient={apiClient} clipboard={clipboard} resuming={resuming} />
        ),
      })
    }
  </SensitiveClipboardBoundary>
);

/** Pairing never receives a bearer; manual disclosure expires with the mounted view. */
export const PATManagementFeature = ({
  children,
}: Pick<PATManagementContentProps, "children">): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const management = usePATManagement(router.options.context.apiClient);
  const queryState = management.query;
  const refreshActivePATs = management.actions.refresh;
  let activePATState: ActivePATManagementState = {
    _tag: queryState._tag === "Initial" && !queryState.waiting ? "Initial" : "Loading",
  };
  if (queryState._tag === "Failure") {
    activePATState = {
      _tag: "LoadFailure",
      boundaryFailure: queryState.failure._tag !== "DeclaredFailure",
      onRetry: refreshActivePATs,
      waiting: queryState.waiting,
    };
  }
  if (queryState._tag === "Ready") {
    activePATState = {
      _tag: "Ready",
      result: queryState.value.data,
      onRetry: refreshActivePATs,
      refreshing: queryState.waiting,
      refreshFailed: Option.isSome(queryState.refreshFailure),
    };
  }
  const resuming = useRouterState({ select: (state) => state.location.search.resume === "pat" });
  return (
    <PATManagementContent
      activePATState={activePATState}
      refreshPATs={refreshActivePATs}
      refreshing={
        (management.task._tag !== "Uncertain" && queryState.waiting) ||
        management.task._tag === "Revoking" ||
        management.task._tag === "Refreshing"
      }
      authentication={authentication}
      apiClient={router.options.context.apiClient}
      resuming={resuming}
      management={management}
    >
      {children}
    </PATManagementContent>
  );
};

export { CLIConnectionFeature } from "./cli-feature";
