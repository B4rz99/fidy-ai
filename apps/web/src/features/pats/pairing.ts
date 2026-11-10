import { useAtomSet } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { type Dispatch, type RefCallback, type SetStateAction, useCallback, useState } from "react";
import { type FidyClient, PATPairingPublicCode, type PATPairingReview } from "@/transport/client";

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
type PairingState =
  | Readonly<{ _tag: "Entering"; publicCode: string }>
  | Readonly<{ _tag: "Inspecting"; publicCode: string }>
  | Readonly<{
      _tag: "Reviewing";
      review: PATPairingReview;
      publicCode: Option.Option<string>;
    }>
  | Readonly<{ _tag: "Approving"; review: PATPairingReview; publicCode: Option.Option<string> }>
  | Readonly<{ _tag: "Invalid"; publicCode: Option.Option<string> }>
  | Readonly<{ _tag: "Approved" }>
  | Readonly<{ _tag: "ApprovalUnknown" }>;
export type PATPairingDisplay = PairingState;
export type PATPairingActions = Readonly<{
  update: (publicCode: string) => void;
  inspect: () => void;
  approve: () => void;
  reset: () => void;
}>;
const entering: PairingState = { _tag: "Entering", publicCode: "" };
const inspectCommand = (apiClient: FidyClient): Atom.AtomResultFn<InspectCommand, void, never> =>
  apiClient.runtime.fn<InspectCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const result = yield* client.pats.inspectPATPairing({
          payload: { publicCode: command.publicCode },
        });
        yield* Effect.sync(() => command.inspected(result.data));
      }).pipe(Effect.catch(() => Effect.sync(command.failed))),
    { concurrent: false }
  );
const approveCommand = (apiClient: FidyClient): Atom.AtomResultFn<ApproveCommand, void, never> =>
  apiClient.runtime.fn<ApproveCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* client.pats.approvePATPairing({ payload: { pairingId: command.pairingId } });
        yield* Effect.sync(command.approved);
      }).pipe(Effect.catch(() => Effect.sync(command.failed))),
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
    previous._tag !== "Entering" ||
    previous.publicCode.trim().length === 0
  ) {
    return;
  }
  const publicCode = previous.publicCode.trim().toUpperCase();
  const pending: PairingState = { _tag: "Inspecting", publicCode };
  owner.change(pending);
  inspect({
    publicCode,
    inspected: (review) => {
      if (owner.lifetime.active && owner.current.value === pending) {
        owner.change({ _tag: "Reviewing", review, publicCode: Option.some(publicCode) });
      }
    },
    failed: () => {
      if (owner.lifetime.active && owner.current.value === pending) {
        owner.change({
          _tag: "Invalid",
          publicCode: Schema.decodeOption(PATPairingPublicCode)(publicCode),
        });
      }
    },
  });
};
const approvePairing = (owner: PairingOwner, approve: (command: ApproveCommand) => void): void => {
  const previous = owner.current.value;
  if (!owner.lifetime.active || previous._tag !== "Reviewing") return;
  const pending: PairingState = { ...previous, _tag: "Approving" };
  owner.change(pending);
  const settle = (next: PairingState): void => {
    if (owner.lifetime.active && owner.current.value === pending) owner.change(next);
  };
  approve({
    pairingId: previous.review.pairingId,
    approved: () => settle({ _tag: "Approved" }),
    failed: () => settle({ _tag: "ApprovalUnknown" }),
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
/** A mounted review binds approval to its retained grant. Cancellation abandons only this view;
 * a dispatched approval may still commit, and its response cannot settle a replacement review. */
export const usePATPairing = ({
  apiClient,
  initialReview,
  publicCode,
}: Readonly<{
  apiClient: FidyClient;
  initialReview: Option.Option<PATPairingReview>;
  publicCode: Option.Option<string>;
}>): Readonly<{
  state: PATPairingDisplay;
  actions: PATPairingActions;
  lifecycleRef: RefCallback<HTMLElement>;
}> => {
  const [state, setState] = useState<PairingState>(() =>
    Option.isSome(initialReview)
      ? { _tag: "Reviewing", review: initialReview.value, publicCode }
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
        if (owner.lifetime.active && owner.current.value._tag === "Entering") {
          owner.change({ _tag: "Entering", publicCode: value });
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
