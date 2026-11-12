import { useAtomSet } from "@effect/atom-react";
import { DateTime, Duration, Effect, type Exit, Option, Redacted, Schema } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type Dispatch, type RefCallback, type SetStateAction, useCallback, useState } from "react";
import { browserSecureRandom } from "@/browser/crypto";
import type { CopyRelease, SensitiveClipboard } from "@/browser/sensitive-clipboard";
import {
  type FidyClient,
  type IssuedPAT,
  type ManualPATGrantInput,
  ManualPATRequestId,
  type ManualPATRequestId as ManualPATRequestIdType,
  type PATId,
  type PATLifetimeDays,
  PATRecipientLabel,
  type PATScope,
  PATScopes,
  defaultPATLifetimeDays,
} from "@/transport/client";
import { type PATDraft, preservePATDraft } from "./reauthentication-draft";
import { activePATReactivityKey } from "./presentation";

type PATScopeValue = PATScope;
type PATRefusal =
  | Readonly<{ _tag: "ReviewExpired" | "Input" | "Consent" | "Authority" }>
  | Readonly<{ _tag: "RateLimited"; retryAt: DateTime.Utc }>;
type IssuanceFailure =
  | Readonly<{ _tag: "Uncertain" }>
  | Readonly<{ _tag: "IdentityConfirmation"; userId: string }>
  | Readonly<{ _tag: "Refused"; refusal: PATRefusal }>;
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
      _tag: "Uncertain";
      grant: ReviewedManualPATGrant;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{
      _tag: "IdentityConfirmation";
      userId: string;
      draft: PATDraft;
      preservationFailed: boolean;
    }>
  | Readonly<{
      _tag: "Refused";
      grant: ReviewedManualPATGrant;
      requestId: ManualPATRequestIdType;
      refusal: PATRefusal;
    }>
  | Readonly<{ _tag: "Issued"; issued: IssuedPAT }>;

const makeManualPATRequestId = (): ManualPATRequestIdType =>
  ManualPATRequestId.make(Effect.runSync(browserSecureRandom.uuidV4().pipe(Effect.orDie)));

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
  return Object.freeze({
    _tag: "Reviewing",
    grant: Object.freeze({
      recipientLabel: PATRecipientLabel.make(state.recipientLabel.trim()),
      scopes: PATScopes.make(Object.freeze([...state.scopes])),
      lifetimeDays: state.lifetimeDays,
      reviewExpiresAt,
    }),
    requestId: makeManualPATRequestId(),
  });
};

export type PATCreationDisplay =
  | Extract<ManualPATCreationState, { _tag: "Editing" | "Issued" }>
  | Readonly<{ _tag: "Reviewing" | "Issuing"; grant: ReviewedManualPATGrant }>
  | Extract<ManualPATCreationState, { _tag: "Uncertain" | "Refused" }>
  | Readonly<{ _tag: "IdentityConfirmation"; preservationFailed: boolean }>;
export type PATCreationActions = Readonly<{
  update: (draft: Extract<ManualPATCreationState, { _tag: "Editing" }>) => void;
  review: () => void;
  edit: () => void;
  confirm: () => void;
  prepareReview: () => void;
  confirmIdentity: () => void;
  reset: () => void;
  copy: (onCopied: () => void) => void;
}>;
type Issuance = Readonly<{
  grant: ManualPATGrantInput;
  requestId: ManualPATRequestIdType;
  deliver: (issued: IssuedPAT) => void;
  fail: (failure: IssuanceFailure) => void;
}>;
type ManualPATError = Effect.Error<
  ReturnType<Effect.Success<FidyClient>["pats"]["createManualPAT"]>
>;
type OrdinaryIssuanceError = Exclude<
  ManualPATError,
  { _tag: "ManualPATReauthenticationRequired" | "ManualPATIssuanceRateLimited" | "ResourceLimited" }
>;
const refusalTags: Readonly<
  Record<OrdinaryIssuanceError["_tag"], Exclude<PATRefusal["_tag"], "RateLimited"> | "Uncertain">
> = {
  ManualPATReviewExpired: "ReviewExpired",
  ValidationFailed: "Input",
  ConsentRequired: "Consent",
  UserActionRequired: "Consent",
  Unauthenticated: "Authority",
  ScopeMissing: "Authority",
  HttpClientError: "Uncertain",
  ManualPATIssuanceConsumed: "Uncertain",
  PaywallRequired: "Uncertain",
  QuotaExhausted: "Uncertain",
  SchemaError: "Uncertain",
  Unavailable: "Uncertain",
};
const classifyIssueError = (error: ManualPATError): IssuanceFailure => {
  if (error._tag === "ManualPATReauthenticationRequired") {
    return { _tag: "IdentityConfirmation", userId: error.error.userId };
  }
  if (error._tag === "ManualPATIssuanceRateLimited" || error._tag === "ResourceLimited") {
    return {
      _tag: "Refused",
      refusal: {
        _tag: "RateLimited",
        retryAt: DateTime.addDuration(
          Effect.runSync(DateTime.now),
          Duration.seconds(error.error.retryAfterSeconds ?? 1)
        ),
      },
    };
  }
  const refusal = refusalTags[error._tag];
  return refusal === "Uncertain"
    ? { _tag: "Uncertain" }
    : { _tag: "Refused", refusal: { _tag: refusal } };
};
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
      }).pipe(Effect.catch((error) => Effect.sync(() => command.fail(classifyIssueError(error))))),
    { concurrent: false }
  );

const display = (state: ManualPATCreationState): PATCreationDisplay => {
  switch (state._tag) {
    case "Reviewing":
    case "Issuing":
      return { _tag: state._tag, grant: state.grant };
    case "Uncertain":
    case "Refused":
      return state;
    case "IdentityConfirmation":
      return { _tag: state._tag, preservationFailed: state.preservationFailed };
    case "Editing":
    case "Issued":
      return state;
  }
};

type IssuanceOwner = Readonly<{
  current: { value: ManualPATCreationState; copyRelease: Option.Option<CopyRelease> };
  lifetime: { active: boolean; generation: number; initialized: boolean };
  change: (next: ManualPATCreationState) => void;
  forget: () => void;
  clear: () => void;
}>;
type Issue = (command: Issuance) => Promise<Exit.Exit<void, never>>;
type CreationBinding = Readonly<{ owner: IssuanceOwner; state: ManualPATCreationState }>;
type DisclosureBinding = Readonly<{ owner: IssuanceOwner; generation: number; patId: PATId }>;
const currentDisclosure = ({ owner, generation, patId }: DisclosureBinding): boolean =>
  owner.lifetime.active &&
  owner.lifetime.generation === generation &&
  owner.current.value._tag === "Issued" &&
  owner.current.value.issued.pat.id === patId;
const expireDisclosure =
  (binding: DisclosureBinding): (() => void) =>
  () => {
    if (currentDisclosure(binding)) binding.owner.forget();
  };
const acknowledgeCopy =
  (binding: DisclosureBinding, copied: () => void): (() => void) =>
  () => {
    if (currentDisclosure(binding)) copied();
  };
const confirmPAT = (
  binding: CreationBinding,
  issue: Issue,
  clipboard: SensitiveClipboard
): void => {
  const { owner, state: previous } = binding;
  const { current, lifetime, change } = owner;
  if (!lifetime.active || current.value !== previous || previous._tag !== "Reviewing") return;
  const generation = lifetime.generation;
  const { grant, requestId } = previous;
  const issuing = { _tag: "Issuing" as const, grant, requestId };
  const live = (): boolean =>
    lifetime.active && lifetime.generation === generation && current.value === issuing;
  change(issuing);
  const fail = (failure: IssuanceFailure): void => {
    if (!live()) return;
    if (failure._tag === "IdentityConfirmation") {
      change({
        _tag: "IdentityConfirmation",
        userId: failure.userId,
        draft: {
          recipientLabel: grant.recipientLabel,
          scopes: grant.scopes,
          lifetimeDays: grant.lifetimeDays,
        },
        preservationFailed: false,
      });
    } else if (failure._tag === "Refused") {
      change({ _tag: "Refused", grant, requestId, refusal: failure.refusal });
    } else change({ _tag: "Uncertain", grant, requestId });
  };
  issue({
    grant,
    requestId,
    fail,
    deliver: (issued) => {
      if (!live()) return;
      change({ _tag: "Issued", issued });
      clipboard.reveal(expireDisclosure({ owner, generation, patId: issued.pat.id }));
    },
  }).then(
    () => fail({ _tag: "Uncertain" }),
    () => fail({ _tag: "Uncertain" })
  );
};
const reviewDraft = ({ owner, state }: CreationBinding): void => {
  if (state._tag !== "Editing") return;
  const draft = { ...state, recipientLabel: state.recipientLabel.trim() };
  if (Schema.is(PATRecipientLabel)(draft.recipientLabel) && Schema.is(PATScopes)(draft.scopes)) {
    owner.change(beginReview(draft));
  }
};
const editingDraft = (draft: PATDraft): Extract<ManualPATCreationState, { _tag: "Editing" }> => ({
  _tag: "Editing",
  recipientLabel: draft.recipientLabel,
  scopes: draft.scopes,
  lifetimeDays: draft.lifetimeDays,
});
const prepareReview = ({ owner, state }: CreationBinding): void => {
  if (state._tag !== "Uncertain" && state._tag !== "Refused") return;
  if (
    state._tag === "Refused" &&
    state.refusal._tag === "RateLimited" &&
    DateTime.isLessThan(Effect.runSync(DateTime.now), state.refusal.retryAt)
  ) {
    return;
  }
  owner.change(editingDraft(state.grant));
};
const creationActions = (
  binding: CreationBinding,
  issue: Issue,
  clipboard: SensitiveClipboard
): PATCreationActions => {
  const { owner, state } = binding;
  const { current, lifetime, change, clear } = owner;
  const live = (): boolean => lifetime.active && current.value === state;
  return {
    update: (draft) => {
      if (live() && state._tag === "Editing") change(draft);
    },
    review: () => {
      if (live()) reviewDraft(binding);
    },
    edit: () => {
      if (!live()) return;
      if (state._tag === "Reviewing") {
        change(editingDraft(state.grant));
      } else if (state._tag === "IdentityConfirmation") {
        change(editingDraft(state.draft));
      }
    },
    confirm: () => {
      if (live()) confirmPAT(binding, issue, clipboard);
    },
    prepareReview: () => {
      if (live()) prepareReview(binding);
    },
    confirmIdentity: () => {
      if (!live()) return;
      if (state._tag !== "IdentityConfirmation") return;
      if (preservePATDraft({ userId: state.userId, draft: state.draft })) {
        window.location.assign("/login?resume=pat");
      } else change({ ...state, preservationFailed: true });
    },
    reset: () => {
      if (live()) clear();
    },
    copy: (onCopied) => {
      if (!live()) return;
      if (state._tag === "Issued") {
        owner.current.copyRelease = Option.some(
          clipboard.copy(
            Redacted.value(state.issued.bearer),
            acknowledgeCopy(
              { owner, generation: lifetime.generation, patId: state.issued.pat.id },
              onCopied
            )
          )
        );
      }
    },
  };
};
const makeIssuanceOwner = (
  setState: Dispatch<SetStateAction<ManualPATCreationState>>
): IssuanceOwner => {
  const current: IssuanceOwner["current"] = { value: initialState, copyRelease: Option.none() };
  const lifetime = { active: false, generation: 0, initialized: false };
  const change = (next: ManualPATCreationState): void => {
    current.value = next;
    setState(next);
  };
  const forget = (): void => {
    lifetime.generation += 1;
    const release = current.copyRelease;
    current.copyRelease = Option.none();
    change({ ...initialState });
    if (Option.isSome(release)) release.value.release();
  };
  const clear = forget;
  return { current, lifetime, change, forget, clear };
};
const mountIssuance =
  (
    { current, lifetime, change, clear }: IssuanceOwner,
    initialDraft: Option.Option<PATDraft>
  ): RefCallback<HTMLElement> =>
  (node) => {
    if (node === null) return;
    lifetime.active = true;
    if (!lifetime.initialized) {
      lifetime.initialized = true;
      if (Option.isSome(initialDraft)) {
        change(beginReview({ _tag: "Editing", ...initialDraft.value }));
      }
    }
    const hide = clear;
    window.addEventListener("pagehide", hide);
    return (): void => {
      lifetime.active = false;
      lifetime.generation += 1;
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
  const [owner] = useState(() => makeIssuanceOwner(setState));
  const [command] = useState(() => issueCommand(apiClient));
  const issue = useAtomSet(command, { mode: "promiseExit" });
  const lifecycleRef = useCallback<RefCallback<HTMLElement>>(
    (node) => mountIssuance(owner, initialDraft)(node),
    [owner, initialDraft]
  );
  return {
    state: display(state),
    lifecycleRef,
    actions: creationActions({ owner, state }, issue, clipboard),
  };
};
