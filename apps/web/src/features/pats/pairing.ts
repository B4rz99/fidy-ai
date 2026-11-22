import { useAtomSet } from "@effect/atom-react";
import { Data, Effect, Option, Predicate, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { type Dispatch, type RefCallback, type SetStateAction, useCallback, useState } from "react";
import { type FidyClient, PATPairingPublicCode, type PATPairingReview } from "@/transport/client";
import { reportBrowserDefect } from "@/transport/browser-defects";

type InspectCommand = Readonly<{
  publicCode: string;
  inspected: (review: PATPairingReview) => void;
  failed: () => void;
}>;

type ApproveCommand = Readonly<{
  pairingId: PATPairingReview["pairingId"];
  approved: () => void;
  failed: () => void;
}>;

type PairingState = Data.TaggedEnum<{
  Entering: { readonly publicCode: string };
  Inspecting: { readonly publicCode: string };
  Reviewing: { readonly review: PATPairingReview; readonly publicCode: Option.Option<string> };
  Approving: { readonly review: PATPairingReview; readonly publicCode: Option.Option<string> };
  Invalid: { readonly publicCode: Option.Option<string> };
  Approved: {};
  ApprovalUnknown: {};
}>;

const PairingState = Data.taggedEnum<PairingState>();

export type PATPairingDisplay = PairingState;

type PATPairingController = Readonly<{
  state: PATPairingDisplay;
  actions: PATPairingActions;
  lifecycleRef: RefCallback<HTMLElement>;
}>;

export type PATPairingActions = Readonly<{
  update: (publicCode: string) => void;
  inspect: () => void;
  approve: () => void;
  reset: () => void;
}>;

const entering: PairingState = PairingState.Entering({ publicCode: "" });

const reportCommandFailure = (failed: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    reportBrowserDefect("command_failed");
    failed();
  });

const inspectCommand = (apiClient: FidyClient): Atom.AtomResultFn<InspectCommand, void, never> =>
  apiClient.runtime.fn<InspectCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;

        const result = yield* client.pats.inspectPATPairing({
          payload: { publicCode: command.publicCode },
        });

        yield* Effect.sync(() => command.inspected(result.data));
      }).pipe(Effect.catch(() => reportCommandFailure(command.failed))),
    { concurrent: false }
  );

const approveCommand = (apiClient: FidyClient): Atom.AtomResultFn<ApproveCommand, void, never> =>
  apiClient.runtime.fn<ApproveCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* client.pats.approvePATPairing({ payload: { pairingId: command.pairingId } });
        yield* Effect.sync(command.approved);
      }).pipe(Effect.catch(() => reportCommandFailure(command.failed))),
    { concurrent: false }
  );

type PairingOwner = {
  lifetime: { active: boolean };
  current: { value: PairingState };
  change: (next: PairingState) => void;
};

const inspectPairing = (owner: PairingOwner, inspect: (command: InspectCommand) => void): void => {
  const previous = owner.current.value;

  if (
    !owner.lifetime.active ||
    !Predicate.isTagged(previous, "Entering") ||
    previous.publicCode.trim().length === 0
  ) {
    return;
  }

  const publicCode = previous.publicCode.trim().toUpperCase();
  const pending: PairingState = PairingState.Inspecting({ publicCode });
  owner.change(pending);
  inspect({
    publicCode,
    inspected: (review) => {
      if (owner.lifetime.active && owner.current.value === pending) {
        owner.change(PairingState.Reviewing({ review, publicCode: Option.some(publicCode) }));
      }
    },
    failed: () => {
      if (owner.lifetime.active && owner.current.value === pending) {
        owner.change(
          PairingState.Invalid({
            publicCode: Schema.decodeOption(PATPairingPublicCode)(publicCode),
          })
        );
      }
    },
  });
};

const approvePairing = (owner: PairingOwner, approve: (command: ApproveCommand) => void): void => {
  const previous = owner.current.value;

  if (!owner.lifetime.active || !Predicate.isTagged(previous, "Reviewing")) return;

  const pending: PairingState = PairingState.Approving({
    review: previous.review,
    publicCode: previous.publicCode,
  });

  owner.change(pending);

  const settle = (next: PairingState): void => {
    if (owner.lifetime.active && owner.current.value === pending) owner.change(next);
  };

  approve({
    pairingId: previous.review.pairingId,
    approved: () => settle(PairingState.Approved()),
    failed: () => settle(PairingState.ApprovalUnknown()),
  });
};

const makePairingOwner = (
  initial: PairingState,
  setState: Dispatch<SetStateAction<PairingState>>
): PairingOwner => {
  const current = { value: initial };

  return {
    current,
    lifetime: { active: false },
    change: (next) => {
      current.value = next;
      setState(next);
    },
  };
};

const mountPairing =
  (owner: PairingOwner): RefCallback<HTMLElement> =>
  (node) => {
    if (node === null) return;
    const lifetime = owner.lifetime;
    lifetime.active = true;

    return (): void => {
      lifetime.active = false;
    };
  };

export const usePATPairing = ({
  apiClient,
  initialReview,
  publicCode,
}: Readonly<{
  apiClient: FidyClient;
  initialReview: Option.Option<PATPairingReview>;
  publicCode: Option.Option<string>;
}>): PATPairingController => {
  const [state, setState] = useState<PairingState>(() =>
    Option.isSome(initialReview)
      ? PairingState.Reviewing({ review: initialReview.value, publicCode })
      : entering
  );

  const [owner] = useState(() => makePairingOwner(state, setState));
  const [inspectAtom] = useState(() => inspectCommand(apiClient));
  const [approveAtom] = useState(() => approveCommand(apiClient));
  const inspect = useAtomSet(inspectAtom);
  const approve = useAtomSet(approveAtom);

  const lifecycleRef = useCallback<RefCallback<HTMLElement>>(
    (node) => mountPairing(owner)(node),
    [owner]
  );

  return {
    state,
    lifecycleRef,
    actions: {
      update: (value) => {
        if (owner.lifetime.active && Predicate.isTagged(owner.current.value, "Entering")) {
          owner.change(PairingState.Entering({ publicCode: value }));
        }
      },
      inspect: () => inspectPairing(owner, inspect),
      approve: () => approvePairing(owner, approve),
      reset: () => {
        if (owner.lifetime.active) owner.change(entering);
      },
    },
  };
};
