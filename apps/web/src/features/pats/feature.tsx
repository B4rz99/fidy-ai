import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type JSX, type ReactNode, type RefCallback, useCallback, useRef, useState } from "react";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { type BrowserAuthentication, useSession } from "@/session/session-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type FidyClient, ManualPATReauthenticationRequired } from "@/transport/client";
import { sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { Button } from "@/ui/components/button";
import { type PATDraft, resumePATDraft } from "./reauthentication-draft";
import { type IssueManualPATCommand, ManualPATView } from "./view";
import {
  type ActivePATManagementState,
  ActivePATManagementView,
  type RevokeActivePATCommand,
  type RevokeAllActivePATsCommand,
} from "./management-view";

const activePATReactivityKey = ["pats", "active"] as const;

type PATManagementContentProps = Readonly<{
  children: (content: Readonly<{ tokens: ReactNode; creation: ReactNode }>) => ReactNode;
  activePATState: ActivePATManagementState;
  authentication: BrowserAuthentication;
  issue: (command: IssueManualPATCommand) => void;
  revoke: (command: RevokeActivePATCommand) => void;
  revokeAll: (command: RevokeAllActivePATsCommand) => void;
}>;

const PATManagementContent = ({
  children,
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
    {(clipboard) =>
      children({
        tokens: (
          <ActivePATManagementView
            state={activePATState}
            revokeAll={revokeAll}
            revokeOne={revoke}
          />
        ),
        creation: <PATCreation initialDraft={Option.none()} clipboard={clipboard} issue={issue} />,
      })
    }
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
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            Schema.is(ManualPATReauthenticationRequired)(error)
              ? command.onReauthenticationRequired(error.error.userId)
              : command.onFailed()
          )
        )
      ),
    { concurrent: false }
  );

/**
 * Coordinates authenticated PAT management and manual issuance.
 * The pairing path never receives a bearer; manual bearers remain confined to the mounted view,
 * with explicit non-fatal clipboard access and bounded clearing.
 */
export const PATManagementFeature = ({
  children,
}: Pick<PATManagementContentProps, "children">): JSX.Element => {
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
    >
      {children}
    </PATManagementContent>
  );
};

export { CLIConnectionFeature } from "./cli-feature";

const PATCreation = (props: Parameters<typeof ManualPATView>[0]): JSX.Element => {
  const resuming = useRouterState({ select: (state) => state.location.search.resume === "pat" });
  return resuming ? <ResumedPATCreation {...props} /> : <ManualPATView {...props} />;
};
const ResumedPATCreation = (props: Parameters<typeof ManualPATView>[0]): JSX.Element => {
  const router = useRouter();
  const [userQuery] = useState(() =>
    router.options.context.apiClient.query("identity", "getCurrentUser", {})
  );
  const result = useAtomValue(userQuery);
  const retry = useAtomRefresh(userQuery);
  const consumed = useRef(false);
  const user = presentCanonicalQuery(result);
  const [draft, setDraft] = useState<Option.Option<Option.Option<PATDraft>>>(() => Option.none());
  const userId = user._tag === "Ready" ? Option.some(user.value.data.id) : Option.none();
  const mounted = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (node !== null && Option.isSome(userId) && !consumed.current) {
        consumed.current = true;
        setDraft(Option.some(resumePATDraft(userId.value)));
      }
    },
    [userId, setDraft]
  );
  if (user._tag === "Failure") {
    return (
      <div role="alert">
        <p>No pudimos comprobar tu identidad. El formulario sigue guardado en esta pestaña.</p>
        <Button type="button" onClick={retry}>
          Volver a intentar
        </Button>
      </div>
    );
  }
  if (Option.isNone(draft)) return <output ref={mounted}>Comprobando tu identidad…</output>;
  return <ManualPATView {...props} initialDraft={draft.value} />;
};
