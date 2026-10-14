import { useAtomSet } from "@effect/atom-react";
import { DateTime, Duration, Effect, type Exit, Option, Redacted, Schema } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type Dispatch, type RefCallback, type SetStateAction, useCallback, useState } from "react";
import { browserCrypto } from "@/browser/crypto";
import type { SensitiveClipboard } from "@/browser/sensitive-clipboard";
import {
  type FidyClient,
  type IssuedPAT,
  type ManualPATGrantInput,
  ManualPATReauthenticationRequired,
  ManualPATRequestId,
  type ManualPATRequestId as ManualPATRequestIdType,
  type PATLifetimeDays,
  PATRecipientLabel,
  type PATScope,
  PATScopes,
  defaultPATLifetimeDays,
} from "@/transport/client";
import { type PATDraft, preservePATDraft } from "./reauthentication-draft";
import { activePATReactivityKey } from "./presentation";

type PATScopeValue = PATScope;
export type ReviewedManualPATGrant = ManualPATGrantInput &
  Readonly<{ reviewExpiresAt: DateTime.Utc }>;
type ManualPATCreationState =
  | Readonly<{
      _tag: "Editing";
      recipientLabel: string;
      scopes: ReadonlyArray<PATScopeValue>;
      lifetimeDays: PATLifetimeDays;
    }>
  | Readonly<{
      _tag: "Reviewing";
      grant: ReviewedManualPATGrant;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{
      _tag: "Issuing";
      grant: ReviewedManualPATGrant;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{
      _tag: "IssueFailed";
      grant: ReviewedManualPATGrant;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{
      _tag: "IdentityConfirmation";
      userId: string;
      draft: PATDraft;
      preservationFailed: boolean;
    }>
  | Readonly<{ _tag: "Issued"; issued: IssuedPAT }>;

const makeManualPATRequestId = (): ManualPATRequestIdType =>
  ManualPATRequestId.make(Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie)));

const initialState: ManualPATCreationState = {
  _tag: "Editing",
  recipientLabel: "",
  scopes: [],
  lifetimeDays: defaultPATLifetimeDays,
};

const beginReview = (
  state: Extract<ManualPATCreationState, { _tag: "Editing" }>
): Extract<ManualPATCreationState, { _tag: "Reviewing" }> => {
  const reviewExpiresAt = DateTime.addDuration(
    Effect.runSync(DateTime.now),
    Duration.days(state.lifetimeDays)
  );
  return {
    _tag: "Reviewing",
    grant: {
      recipientLabel: PATRecipientLabel.make(state.recipientLabel.trim()),
      scopes: PATScopes.make(state.scopes),
      lifetimeDays: state.lifetimeDays,
      reviewExpiresAt,
    },
    requestId: makeManualPATRequestId(),
  };
};

/** Presentation receives no request identity or User-bound handoff data. */
export type PATCreationDisplay =
  | Extract<ManualPATCreationState, { _tag: "Editing" | "Issued" }>
  | Readonly<{ _tag: "Reviewing" | "Issuing"; grant: ReviewedManualPATGrant }>
  | Readonly<{ _tag: "IssueFailed" }>
  | Readonly<{ _tag: "IdentityConfirmation"; preservationFailed: boolean }>;
export type PATCreationActions = Readonly<{
  update: (draft: Extract<ManualPATCreationState, { _tag: "Editing" }>) => void;
  review: () => void;
  edit: () => void;
  confirm: () => void;
  retry: () => void;
  confirmIdentity: () => void;
  reset: () => void;
  copy: (onCopied: () => void) => void;
}>;
type Issuance = Readonly<{
  grant: ManualPATGrantInput;
  requestId: ManualPATRequestIdType;
  deliver: (issued: IssuedPAT) => void;
  fail: (userId: Option.Option<string>) => void;
}>;
const issueCommand = (apiClient: FidyClient): Atom.AtomResultFn<Issuance, void, never> =>
  apiClient.runtime.fn<Issuance>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* Reactivity.mutation(
          client.pats.createManualPAT({
            payload: { requestId: command.requestId, grant: command.grant },
          }),
          [activePATReactivityKey]
        );
        yield* Effect.sync(() => command.deliver(response.data));
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            command.fail(
              Schema.is(ManualPATReauthenticationRequired)(error)
                ? Option.some(error.error.userId)
                : Option.none()
            )
          )
        )
      ),
    { concurrent: false }
  );

const display = (state: ManualPATCreationState): PATCreationDisplay => {
  switch (state._tag) {
    case "Reviewing":
    case "Issuing":
      return { _tag: state._tag, grant: state.grant };
    case "IssueFailed":
      return { _tag: state._tag };
    case "IdentityConfirmation":
      return { _tag: state._tag, preservationFailed: state.preservationFailed };
    case "Editing":
    case "Issued":
      return state;
  }
};

type IssuanceOwner = Readonly<{
  current: { value: ManualPATCreationState };
  lifetime: { active: boolean; generation: number; initialized: boolean };
  change: (next: ManualPATCreationState) => void;
  clear: () => void;
}>;
type Issue = (command: Issuance) => Promise<Exit.Exit<void, never>>;
const confirmPAT = (
  { current, lifetime, change, clear }: IssuanceOwner,
  issue: Issue,
  clipboard: SensitiveClipboard
): void => {
  const previous = current.value;
  const owner = lifetime;
  if (!owner.active || previous._tag !== "Reviewing") return;
  const generation = owner.generation;
  const { grant, requestId } = previous;
  const live = (): boolean =>
    owner.active && owner.generation === generation && current.value._tag === "Issuing";
  change({ _tag: "Issuing", grant, requestId });
  const fail = (userId: Option.Option<string>): void => {
    if (!live()) return;
    change(
      Option.match(userId, {
        onNone: () => ({ _tag: "IssueFailed" as const, grant, requestId }),
        onSome: (id) => ({
          _tag: "IdentityConfirmation" as const,
          userId: id,
          draft: {
            recipientLabel: grant.recipientLabel,
            scopes: grant.scopes,
            lifetimeDays: grant.lifetimeDays,
          },
          preservationFailed: false,
        }),
      })
    );
  };
  issue({
    grant,
    requestId,
    fail,
    deliver: (issued) => {
      if (!live()) return;
      change({ _tag: "Issued", issued });
      clipboard.reveal(() => {
        if (
          owner.active &&
          owner.generation === generation &&
          current.value._tag === "Issued" &&
          current.value.issued.pat.id === issued.pat.id
        ) {
          clear();
        }
      });
    },
  }).then(
    () => fail(Option.none()),
    () => fail(Option.none())
  );
};
const creationActions = (
  owner: IssuanceOwner,
  issue: Issue,
  clipboard: SensitiveClipboard
): PATCreationActions => {
  const { current, change, clear } = owner;
  return {
    update: (draft) => {
      if (current.value._tag === "Editing") change(draft);
    },
    review: () => {
      if (current.value._tag !== "Editing") return;
      const draft = { ...current.value, recipientLabel: current.value.recipientLabel.trim() };
      if (
        Schema.is(PATRecipientLabel)(draft.recipientLabel) &&
        Schema.is(PATScopes)(draft.scopes)
      ) {
        change(beginReview(draft));
      }
    },
    edit: () => {
      const previous = current.value;
      if (previous._tag === "Reviewing") {
        change({
          _tag: "Editing",
          recipientLabel: previous.grant.recipientLabel,
          scopes: previous.grant.scopes,
          lifetimeDays: previous.grant.lifetimeDays,
        });
      } else if (previous._tag === "IdentityConfirmation") {
        change({ _tag: "Editing", ...previous.draft });
      }
    },
    confirm: () => confirmPAT(owner, issue, clipboard),
    retry: () => {
      const previous = current.value;
      if (previous._tag === "IssueFailed") change({ ...previous, _tag: "Reviewing" });
    },
    confirmIdentity: () => {
      const previous = current.value;
      if (previous._tag !== "IdentityConfirmation") return;
      if (preservePATDraft({ userId: previous.userId, draft: previous.draft })) {
        window.location.assign("/auth/google?resume=pat");
      } else change({ ...previous, preservationFailed: true });
    },
    reset: clear,
    copy: (onCopied) => {
      const previous = current.value;
      if (previous._tag === "Issued") {
        clipboard.copy(Redacted.value(previous.issued.bearer), onCopied);
      }
    },
  };
};
const makeIssuanceOwner = (
  setState: Dispatch<SetStateAction<ManualPATCreationState>>,
  clipboard: SensitiveClipboard
): IssuanceOwner => {
  const current: IssuanceOwner["current"] = { value: initialState };
  const lifetime = { active: false, generation: 0, initialized: false };
  const change = (next: ManualPATCreationState): void => {
    current.value = next;
    setState(next);
  };
  const clear = (): void => {
    const previous = current.value;
    if (previous._tag === "Issued") clipboard.clear(Redacted.value(previous.issued.bearer));
    change(initialState);
  };
  return { current, lifetime, change, clear };
};
const mountIssuance =
  (
    { current, lifetime, change, clear }: IssuanceOwner,
    initialDraft: Option.Option<PATDraft>
  ): RefCallback<HTMLElement> =>
  (node) => {
    if (node === null) return;
    const owner = lifetime;
    owner.active = true;
    if (!owner.initialized) {
      owner.initialized = true;
      if (Option.isSome(initialDraft)) {
        change(beginReview({ _tag: "Editing", ...initialDraft.value }));
      }
    }
    const hide = (): void => {
      owner.generation += 1;
      clear();
    };
    window.addEventListener("pagehide", hide);
    return (): void => {
      owner.active = false;
      owner.generation += 1;
      window.removeEventListener("pagehide", hide);
      if (current.value._tag === "Issued") clear();
    };
  };
/** One mounted manual PAT lifecycle. Canonical work uses the authentication registry;
 * command results are void so a bearer cannot enter an Atom cache. Late completions cannot
 * disclose after disposal. Restoration only creates a fresh review, never an issuance.
 */
export const usePATIssuance = ({
  apiClient,
  clipboard,
  initialDraft,
}: Readonly<{
  apiClient: FidyClient;
  clipboard: SensitiveClipboard;
  initialDraft: Option.Option<PATDraft>;
}>): Readonly<{
  state: PATCreationDisplay;
  actions: PATCreationActions;
  lifecycleRef: RefCallback<HTMLElement>;
}> => {
  const [state, setState] = useState<ManualPATCreationState>(initialState);
  const [owner] = useState(() => makeIssuanceOwner(setState, clipboard));
  const [command] = useState(() => issueCommand(apiClient));
  const issue = useAtomSet(command, { mode: "promiseExit" });
  const lifecycleRef = useCallback<RefCallback<HTMLElement>>(
    (node) => mountIssuance(owner, initialDraft)(node),
    [owner, initialDraft]
  );
  return { state: display(state), lifecycleRef, actions: creationActions(owner, issue, clipboard) };
};
