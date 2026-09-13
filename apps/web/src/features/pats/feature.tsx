import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { type Atom, Reactivity } from "effect/unstable/reactivity";
import { type JSX, useState } from "react";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { useSession } from "@/session/session-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type FidyClient } from "@/transport/client";
import { bearerRevealLifetime } from "./policy";
import { type IssueManualPATCommand, ManualPATView } from "./view";
import {
  type ActivePATManagementState,
  ActivePATManagementView,
  type RevokeActivePATCommand,
  type RevokeAllActivePATsCommand,
} from "./management-view";
import {
  type ApprovePATPairingCommand,
  type InspectPATPairingCommand,
  PATPairingView,
} from "./pairing-view";

const activePATReactivityKey = ["pats", "active"] as const;

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

const makeInspectPairingCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<InspectPATPairingCommand, void, never> =>
  apiClient.runtime.fn<InspectPATPairingCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* client.pats.inspectPATPairing({
          payload: { publicCode: command.publicCode },
        });
        yield* Effect.sync(() => command.onInspected(response.data));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const makeApprovePairingCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<ApprovePATPairingCommand, void, never> =>
  apiClient.runtime.fn<ApprovePATPairingCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* client.pats.approvePATPairing({
          payload: { pairingId: command.pairingId, patExpiresAt: command.patExpiresAt },
        });
        yield* Effect.sync(command.onApproved);
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

/**
 * Coordinates authenticated PAT management: direct-client pairing approval and manual issuance.
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
  const [inspectAtom] = useState(() => makeInspectPairingCommand(router.options.context.apiClient));
  const [approveAtom] = useState(() => makeApprovePairingCommand(router.options.context.apiClient));
  const revoke = useAtomSet(revokeAtom);
  const revokeAll = useAtomSet(revokeAllAtom);
  const issue = useAtomSet(issueAtom);
  const inspect = useAtomSet(inspectAtom);
  const approve = useAtomSet(approveAtom);
  return (
    <SensitiveClipboardBoundary
      className={Option.some("flex flex-col gap-8")}
      key={authentication}
      lifetime={bearerRevealLifetime}
    >
      {(clipboard) => (
        <>
          <ActivePATManagementView
            state={activePATState}
            revokeAll={revokeAll}
            revokeOne={revoke}
          />
          <PATPairingView approve={approve} inspect={inspect} />
          <ManualPATView clipboard={clipboard} issue={issue} />
        </>
      )}
    </SensitiveClipboardBoundary>
  );
};
