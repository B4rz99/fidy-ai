import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { type JSX, useState } from "react";
import { useSession } from "@/session/session-context";
import { type FidyClient, type TokenBearer } from "@/transport/client";
import { bearerRevealLifetime } from "./policy";
import { type IssueManualPATCommand, ManualPATView } from "./view";
import {
  type ApprovePATPairingCommand,
  type InspectPATPairingCommand,
  PATPairingView,
} from "./pairing-view";

const makeIssueCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<IssueManualPATCommand, void, never> =>
  apiClient.runtime.fn<IssueManualPATCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* client.pats.createManualPAT({
          payload: { requestId: command.requestId, grant: command.grant },
        });
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

const clearClipboard = (bearer: TokenBearer): void => {
  Effect.runFork(
    Effect.promise(() => navigator.clipboard.readText()).pipe(
      Effect.flatMap((current) =>
        current === bearer ? Effect.promise(() => navigator.clipboard.writeText("")) : Effect.void
      ),
      Effect.ignore
    )
  );
};

const copyToClipboard = (bearer: TokenBearer, onCopied: () => void): void => {
  Effect.runFork(
    Effect.promise(() => navigator.clipboard.writeText(bearer)).pipe(
      Effect.tap(() => Effect.sync(onCopied)),
      Effect.tap(() => Effect.sleep(bearerRevealLifetime)),
      Effect.tap(() => Effect.sync(() => clearClipboard(bearer))),
      Effect.ignore
    )
  );
};

/**
 * Coordinates authenticated PAT management: direct-client pairing approval and manual issuance.
 * The pairing path never receives a bearer; manual bearers remain confined to the mounted view,
 * with explicit non-fatal clipboard access and bounded clearing.
 */
export const PATManagementFeature = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const [issueAtom] = useState(() => makeIssueCommand(router.options.context.apiClient));
  const [inspectAtom] = useState(() => makeInspectPairingCommand(router.options.context.apiClient));
  const [approveAtom] = useState(() => makeApprovePairingCommand(router.options.context.apiClient));
  const issue = useAtomSet(issueAtom);
  const inspect = useAtomSet(inspectAtom);
  const approve = useAtomSet(approveAtom);
  return (
    <div className="flex flex-col gap-8" key={authentication}>
      <PATPairingView approve={approve} inspect={inspect} />
      <ManualPATView
        clearClipboard={clearClipboard}
        copyToClipboard={copyToClipboard}
        issue={issue}
      />
    </div>
  );
};
