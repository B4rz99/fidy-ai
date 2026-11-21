import { useAtomSet } from "@effect/atom-react";
import {
  Data,
  DateTime,
  Duration,
  Effect,
  type Exit,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { type Atom, Reactivity } from "effect/reactivity";
import { type Dispatch, type RefCallback, type SetStateAction, useCallback, useState } from "react";
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

type PATRefusal = Data.TaggedEnum<{
  ReviewExpired: {};
  Input: {};
  Consent: {};
  Authority: {};
  RateLimited: { readonly retryAt: DateTime.Utc };
}>;

const PATRefusal = Data.taggedEnum<PATRefusal>();

type IssuanceFailure = Data.TaggedEnum<{
  Uncertain: {};
  IdentityConfirmation: { readonly userId: string };
  Refused: { readonly refusal: PATRefusal };
}>;

const IssuanceFailure = Data.taggedEnum<IssuanceFailure>();

export type ReviewedManualPATGrant = ManualPATGrantInput &
  Readonly<{ reviewExpiresAt: DateTime.Utc }>;

type EditingDraft = Readonly<{
  recipientLabel: string;
  scopes: ReadonlyArray<PATScopeValue>;
  lifetimeDays: PATLifetimeDays;
}>;

type PendingGrant = Readonly<{
  grant: ReviewedManualPATGrant;
  requestId: ManualPATRequestIdType;
}>;

type RefusedGrant = PendingGrant & Readonly<{ refusal: PATRefusal }>;

type IssuedDisclosure = Readonly<{ issued: IssuedPAT }>;

type ManualPATCreationState = Data.TaggedEnum<{
  Editing: EditingDraft;
  Reviewing: PendingGrant;
  Issuing: PendingGrant;
  Uncertain: PendingGrant;
  IdentityConfirmation: Readonly<{
    userId: string;
    draft: PATDraft;
    preservationFailed: boolean;
  }>;
  Refused: RefusedGrant;
  Issued: IssuedDisclosure;
}>;

const ManualPATCreationState = Data.taggedEnum<ManualPATCreationState>();

type EditingState = Data.TaggedEnum.Value<ManualPATCreationState, "Editing">;

const makeManualPATRequestId = (): ManualPATRequestIdType =>
  ManualPATRequestId.make(SecureRandom.uuidV4Unsafe());

const initialState: ManualPATCreationState = ManualPATCreationState.Editing({
  recipientLabel: "",
  scopes: [],
  lifetimeDays: defaultPATLifetimeDays,
});

const beginReview = (
  state: EditingState
): Data.TaggedEnum.Value<ManualPATCreationState, "Reviewing"> => {
  const reviewExpiresAt = DateTime.addDuration(
    DateTime.nowUnsafe(),
    Duration.days(state.lifetimeDays)
  );

  return Object.freeze(
    ManualPATCreationState.Reviewing({
      grant: Object.freeze({
        recipientLabel: PATRecipientLabel.make(state.recipientLabel.trim()),
        scopes: PATScopes.make(Object.freeze([...state.scopes])),
        lifetimeDays: state.lifetimeDays,
        reviewExpiresAt,
      }),
      requestId: makeManualPATRequestId(),
    })
  );
};

type ReviewedGrant = Readonly<{ grant: ReviewedManualPATGrant }>;

export type PATCreationDisplay = Data.TaggedEnum<{
  Editing: EditingDraft;
  Reviewing: ReviewedGrant;
  Issuing: ReviewedGrant;
  Uncertain: PendingGrant;
  Refused: RefusedGrant;
  IdentityConfirmation: Readonly<{ preservationFailed: boolean }>;
  Issued: IssuedDisclosure;
}>;

export const PATCreationDisplay = Data.taggedEnum<PATCreationDisplay>();

type PATCreationController = Readonly<{
  state: PATCreationDisplay;
  actions: PATCreationActions;
  lifecycleRef: RefCallback<HTMLElement>;
}>;

export type PATCreationActions = Readonly<{
  update: (draft: EditingState) => void;
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
  Data.TaggedEnum.Value<
    ManualPATError,
    "ManualPATReauthenticationRequired" | "ManualPATIssuanceRateLimited" | "ResourceLimited"
  >
>;

const refused =
  (refusal: () => PATRefusal): (() => IssuanceFailure) =>
  () =>
    IssuanceFailure.Refused({ refusal: refusal() });

const ordinaryFailures: Readonly<Record<OrdinaryIssuanceError["_tag"], () => IssuanceFailure>> = {
  ManualPATReviewExpired: refused(PATRefusal.ReviewExpired),
  ValidationFailed: refused(PATRefusal.Input),
  ConsentRequired: refused(PATRefusal.Consent),
  UserActionRequired: refused(PATRefusal.Consent),
  Unauthenticated: refused(PATRefusal.Authority),
  ScopeMissing: refused(PATRefusal.Authority),
  HttpClientError: IssuanceFailure.Uncertain,
  ManualPATIssuanceConsumed: IssuanceFailure.Uncertain,
  PaywallRequired: IssuanceFailure.Uncertain,
  QuotaExhausted: IssuanceFailure.Uncertain,
  SchemaError: IssuanceFailure.Uncertain,
  Unavailable: IssuanceFailure.Uncertain,
};

const classifyIssueError = (error: ManualPATError): IssuanceFailure => {
  if (Predicate.isTagged(error, "ManualPATReauthenticationRequired")) {
    return IssuanceFailure.IdentityConfirmation({ userId: error.error.userId });
  }

  if (
    Predicate.isTagged(error, "ManualPATIssuanceRateLimited") ||
    Predicate.isTagged(error, "ResourceLimited")
  ) {
    return IssuanceFailure.Refused({
      refusal: PATRefusal.RateLimited({
        retryAt: DateTime.addDuration(
          DateTime.nowUnsafe(),
          Duration.seconds(error.error.retryAfterSeconds ?? 1)
        ),
      }),
    });
  }

  return ordinaryFailures[error._tag]();
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

const display: (state: ManualPATCreationState) => PATCreationDisplay =
  ManualPATCreationState.$match({
    Reviewing: ({ grant }) => PATCreationDisplay.Reviewing({ grant }),
    Issuing: ({ grant }) => PATCreationDisplay.Issuing({ grant }),
    Uncertain: (state) => state,
    Refused: (state) => state,
    IdentityConfirmation: ({ preservationFailed }) =>
      PATCreationDisplay.IdentityConfirmation({ preservationFailed }),
    Editing: (state) => state,
    Issued: (state) => state,
  });

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
  Predicate.isTagged(owner.current.value, "Issued") &&
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

  if (
    !lifetime.active ||
    current.value !== previous ||
    !Predicate.isTagged(previous, "Reviewing")
  ) {
    return;
  }

  const generation = lifetime.generation;
  const { grant, requestId } = previous;
  const issuing = ManualPATCreationState.Issuing({ grant, requestId });

  const live = (): boolean =>
    lifetime.active && lifetime.generation === generation && current.value === issuing;

  change(issuing);

  const fail = (failure: IssuanceFailure): void => {
    if (!live()) return;

    if (Predicate.isTagged(failure, "IdentityConfirmation")) {
      change(
        ManualPATCreationState.IdentityConfirmation({
          userId: failure.userId,
          draft: {
            recipientLabel: grant.recipientLabel,
            scopes: grant.scopes,
            lifetimeDays: grant.lifetimeDays,
          },
          preservationFailed: false,
        })
      );
    } else if (Predicate.isTagged(failure, "Refused")) {
      change(ManualPATCreationState.Refused({ grant, requestId, refusal: failure.refusal }));
    } else change(ManualPATCreationState.Uncertain({ grant, requestId }));
  };

  issue({
    grant,
    requestId,
    fail,
    deliver: (issued) => {
      if (!live()) return;
      change(ManualPATCreationState.Issued({ issued }));
      clipboard.reveal(expireDisclosure({ owner, generation, patId: issued.pat.id }));
    },
  }).then(
    () => fail(IssuanceFailure.Uncertain()),
    () => fail(IssuanceFailure.Uncertain())
  );
};

const reviewDraft = ({ owner, state }: CreationBinding): void => {
  if (!Predicate.isTagged(state, "Editing")) return;
  const draft = { ...state, recipientLabel: state.recipientLabel.trim() };

  if (Schema.is(PATRecipientLabel)(draft.recipientLabel) && Schema.is(PATScopes)(draft.scopes)) {
    owner.change(beginReview(draft));
  }
};

const editingDraft = (draft: PATDraft): EditingState =>
  ManualPATCreationState.Editing({
    recipientLabel: draft.recipientLabel,
    scopes: draft.scopes,
    lifetimeDays: draft.lifetimeDays,
  });

const prepareReview = ({ owner, state }: CreationBinding): void => {
  if (!Predicate.isTagged(state, "Uncertain") && !Predicate.isTagged(state, "Refused")) return;

  if (
    Predicate.isTagged(state, "Refused") &&
    Predicate.isTagged(state.refusal, "RateLimited") &&
    DateTime.isLessThan(DateTime.nowUnsafe(), state.refusal.retryAt)
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
      if (live() && Predicate.isTagged(state, "Editing")) change(draft);
    },
    review: () => {
      if (live()) reviewDraft(binding);
    },
    edit: () => {
      if (!live()) return;

      if (Predicate.isTagged(state, "Reviewing")) {
        change(editingDraft(state.grant));
      } else if (Predicate.isTagged(state, "IdentityConfirmation")) {
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

      if (!Predicate.isTagged(state, "IdentityConfirmation")) return;

      if (preservePATDraft({ userId: state.userId, draft: state.draft })) {
        window.location.assign("/login?resume=pat");
      } else change({ ...state, preservationFailed: true });
    },
    reset: () => {
      if (live()) clear();
    },
    copy: (onCopied) => {
      if (!live()) return;

      if (Predicate.isTagged(state, "Issued")) {
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
        change(beginReview(ManualPATCreationState.Editing(initialDraft.value)));
      }
    }

    const hide = clear;
    window.addEventListener("pagehide", hide);

    return (): void => {
      lifetime.active = false;
      lifetime.generation += 1;
      window.removeEventListener("pagehide", hide);

      if (Predicate.isTagged(current.value, "Issued")) clear();
    };
  };

export const usePATIssuance = ({
  apiClient,
  clipboard,
  initialDraft,
}: Readonly<{
  apiClient: FidyClient;
  clipboard: SensitiveClipboard;
  initialDraft: Option.Option<PATDraft>;
}>): PATCreationController => {
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
