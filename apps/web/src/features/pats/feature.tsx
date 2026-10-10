import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type JSX, useState } from "react";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { type BrowserAuthentication, useSession } from "@/session/session-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type FidyClient } from "@/transport/client";
import { sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";
import { type IssueManualPATCommand, ManualPATView } from "./view";
import {
  type ActivePATManagementState,
  ActivePATManagementView,
  type RevokeActivePATCommand,
  type RevokeAllActivePATsCommand,
} from "./management-view";

const activePATReactivityKey = ["pats", "active"] as const;

type PATManagementContentProps = Readonly<{
  activePATState: ActivePATManagementState;
  authentication: BrowserAuthentication;
  issue: (command: IssueManualPATCommand) => void;
  revoke: (command: RevokeActivePATCommand) => void;
  revokeAll: (command: RevokeAllActivePATsCommand) => void;
}>;

const PATManagementContent = ({
  activePATState,
  authentication,
  issue,
  revoke,
  revokeAll,
}: PATManagementContentProps): JSX.Element => (
  <SensitiveClipboardBoundary
    className={Option.some("min-w-0")}
    key={authentication}
    lifetime={sensitiveClipboardLifetime}
  >
    {(clipboard) => (
      <main className="min-w-0 xl:grid xl:min-h-svh xl:grid-rows-[auto_1fr]">
        <WorkspaceHeader
          title="Tokens de acceso"
          context={
            <p className="mt-1 text-sm text-muted-foreground">
              Administra el acceso de tus agentes a Fidy.
            </p>
          }
        >
          {null}
        </WorkspaceHeader>
        <WorkspaceColumns
          panel={
            <aside className="min-w-0 border-t bg-card p-5 xl:border-t-0 xl:border-l">
              <ManualPATView clipboard={clipboard} issue={issue} />
            </aside>
          }
        >
          <div className="flex min-w-0 flex-col gap-8">
            <ActivePATManagementView
              state={activePATState}
              revokeAll={revokeAll}
              revokeOne={revoke}
            />
          </div>
        </WorkspaceColumns>
      </main>
    )}
  </SensitiveClipboardBoundary>
);

const makeRevokeActivePATCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<RevokeActivePATCommand, void, never> =>
  apiClient.runtime.fn<RevokeActivePATCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* Reactivity.mutation(
          client.pats.revokePAT({ params: { shortId: command.shortId } }),
          [activePATReactivityKey]
        );
        yield* Effect.sync(command.onRevoked);
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const makeRevokeAllActivePATsCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<RevokeAllActivePATsCommand, void, never> =>
  apiClient.runtime.fn<RevokeAllActivePATsCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* Reactivity.mutation(client.pats.revokeAllPATs({}), [
          activePATReactivityKey,
        ]);
        yield* Effect.sync(() => command.onRevoked(response.data.revokedCount));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const makeIssueCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<IssueManualPATCommand, void, never> =>
  apiClient.runtime.fn<IssueManualPATCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* Reactivity.mutation(
          client.pats.createManualPAT({
            payload: { requestId: command.requestId, grant: command.grant },
          }),
          [activePATReactivityKey]
        );
        yield* Effect.sync(() => command.onIssued(response.data));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

/**
 * Coordinates authenticated PAT management and manual issuance.
 * The pairing path never receives a bearer; manual bearers remain confined to the mounted view,
 * with explicit non-fatal clipboard access and bounded clearing.
 */
export const PATManagementFeature = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const [activePATs] = useState(() =>
    router.options.context.apiClient.query("pats", "listPATs", {
      reactivityKeys: [activePATReactivityKey],
    })
  );
  const activePATResult = useAtomValue(activePATs);
  const refreshActivePATs = useAtomRefresh(activePATs);
  const queryState = presentCanonicalQuery(activePATResult);
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
  const [revokeAtom] = useState(() => makeRevokeActivePATCommand(router.options.context.apiClient));
  const [revokeAllAtom] = useState(() =>
    makeRevokeAllActivePATsCommand(router.options.context.apiClient)
  );
  const [issueAtom] = useState(() => makeIssueCommand(router.options.context.apiClient));
  const revoke = useAtomSet(revokeAtom);
  const revokeAll = useAtomSet(revokeAllAtom);
  const issue = useAtomSet(issueAtom);
  return (
    <PATManagementContent
      activePATState={activePATState}
      authentication={authentication}
      issue={issue}
      revoke={revoke}
      revokeAll={revokeAll}
    />
  );
};

export { CLIConnectionFeature } from "./cli-feature";
