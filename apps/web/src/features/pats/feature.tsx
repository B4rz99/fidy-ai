import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { type JSX, useState } from "react";
import { useSession } from "@/session/session-context";
import { type FidyClient, type TokenBearer } from "@/transport/client";
import { bearerRevealLifetime } from "./policy";
import { type IssueManualPATCommand, ManualPATView } from "./view";

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

const copyToClipboard = (bearer: TokenBearer): void => {
  Effect.runFork(
    Effect.promise(() => navigator.clipboard.writeText(bearer)).pipe(
      Effect.tap(() => Effect.sleep(bearerRevealLifetime)),
      Effect.tap(() => Effect.sync(() => clearClipboard(bearer))),
      Effect.ignore
    )
  );
};

/**
 * Runs authenticated manual PAT issuance and confines the disclosed bearer to the mounted view.
 * Clipboard access is explicit, failures are non-fatal, and matching copied bearers are cleared
 * after ten minutes or when the view clears its issued state.
 */
export const ManualPATFeature = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const [issueAtom] = useState(() => makeIssueCommand(router.options.context.apiClient));
  const issue = useAtomSet(issueAtom);
  return (
    <ManualPATView
      key={authentication}
      clearClipboard={clearClipboard}
      copyToClipboard={copyToClipboard}
      issue={issue}
    />
  );
};
