import { EmailReplacementViewState } from "./view-state";
import {
  clearReplacementAdmission,
  restoreReplacementAdmission,
  retainReplacementAdmission,
} from "./admission";
import { Cause, Context, Effect, Exit, Option, Predicate, Schema } from "effect";
import { Atom } from "effect/reactivity";
import {
  EmailAddress,
  type EmailAddress as EmailAddressType,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailVerificationCode,
  type FidyClient,
  type WebAuthClient,
} from "@/transport/client";

type Work = (get: Atom.FnContext) => Effect.Effect<void>;

type BindingFailure = Effect.Error<
  ReturnType<WebAuthClient["Service"]["browserSession"]["binding"]>
>;

type Dispatch = (input: void | typeof Atom.Interrupt) => void;

type Owner = {
  apiClient: FidyClient;
  state: EmailReplacementViewState;
  active: boolean;
  generation: number;
  pending: Option.Option<Work>;
  publish: (state: EmailReplacementViewState) => void;
  uncertain: boolean;
  onUncertain: (uncertain: boolean) => void;
  binding: string;
  webAuthClient: WebAuthClient;
};

type Intent = Readonly<{ owner: Owner; dispatch: Dispatch; generation: number }>;

export type ReplacementActions = Readonly<{
  request: (candidateEmail: string) => void;
  repeat: () => void;
  complete: (combinedCode: string) => void;
  restart: () => void;
}>;

type Replacement = Readonly<{
  atom: Atom.AtomResultFn<void, void>;
  mount: (dispatch: Dispatch) => () => void;
  actions: (dispatch: Dispatch) => ReplacementActions;
}>;

const editing = (): EmailReplacementViewState =>
  EmailReplacementViewState.Editing({ feedback: "none", draftEmail: "" });

const live = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;

const change = (owner: Owner, state: EmailReplacementViewState): void => {
  owner.state = state;
  owner.publish(state);
};

const requiresFreshPairing = (failure: unknown): boolean =>
  Schema.is(EmailReplacementFreshPairingRequiredApi)(failure) ||
  Predicate.isTagged(failure, "Unauthenticated");

const requestFailureState = (
  cause: Cause.Cause<unknown>,
  draftEmail: string
): EmailReplacementViewState =>
  Option.exists(Cause.findErrorOption(cause), requiresFreshPairing)
    ? EmailReplacementViewState.FreshPairingRequired()
    : EmailReplacementViewState.Editing({ feedback: "request-unavailable", draftEmail });

const completionFailureState = (
  cause: Cause.Cause<unknown>,
  candidateEmail: EmailAddressType
): EmailReplacementViewState => {
  const failure = Cause.findErrorOption(cause);

  if (Option.exists(failure, requiresFreshPairing)) {
    return EmailReplacementViewState.FreshPairingRequired();
  }

  return Option.exists(failure, Schema.is(EmailReplacementInvalidApi))
    ? EmailReplacementViewState.InvalidCode({ candidateEmail })
    : EmailReplacementViewState.Uncertain();
};

const runRequest = (
  { owner, dispatch }: Pick<Intent, "owner" | "dispatch">,
  candidateEmail: EmailAddressType,
  draftEmail: string
): void => {
  owner.generation += 1;
  const generation = owner.generation;
  change(owner, EmailReplacementViewState.Requesting({ candidateEmail }));
  owner.pending = Option.some(() =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const client = yield* owner.apiClient;

          return yield* client.emailAuthentication.requestEmailReplacement({
            payload: { candidateEmail },
          });
        })
      );

      if (!live(owner, generation)) {
        return;
      }

      change(
        owner,
        Exit.isSuccess(result)
          ? EmailReplacementViewState.AwaitingCode({ candidateEmail })
          : requestFailureState(result.cause, draftEmail)
      );
    })
  );
  dispatch(undefined);
};

const request = ({ owner, dispatch, generation }: Intent, candidateEmail: string): void => {
  if (!live(owner, generation) || !EmailReplacementViewState.$is("Editing")(owner.state)) {
    return;
  }

  const candidate = Schema.decodeOption(EmailAddress)(candidateEmail);

  if (Option.isNone(candidate)) {
    change(
      owner,
      EmailReplacementViewState.Editing({ feedback: "invalid-candidate", draftEmail: "" })
    );

    return;
  }

  runRequest({ owner, dispatch }, candidate.value, candidateEmail);
};

const awaitingProof = Predicate.or(
  EmailReplacementViewState.$is("AwaitingCode"),
  EmailReplacementViewState.$is("InvalidCode")
);

const repeat = (owner: Owner, dispatch: Dispatch, generation: number): void => {
  if (!live(owner, generation)) {
    return;
  }

  const current = owner.state;

  if (awaitingProof(current)) {
    runRequest({ owner, dispatch }, current.candidateEmail, current.candidateEmail);
  }
};

const setUncertain = (owner: Owner, uncertain: boolean): void => {
  owner.uncertain = uncertain;
  owner.onUncertain(uncertain);
};

const prepareCompletion = (
  { owner, generation }: Intent,
  get: Atom.FnContext
): Effect.Effect<FidyClient["Service"], BindingFailure | void> =>
  Effect.gen(function* () {
    const context = yield* get.result(owner.webAuthClient.runtime, { suspendOnWaiting: true });
    const authentication = Context.get(context, owner.webAuthClient);
    const observation = yield* authentication.browserSession.binding({ query: {} });

    if (!live(owner, generation) || observation.binding !== owner.binding) {
      return yield* Effect.fail(undefined);
    }

    const client = yield* owner.apiClient;

    if (!live(owner, generation)) {
      return yield* Effect.interrupt;
    }

    if (!retainReplacementAdmission(owner.binding)) {
      return yield* Effect.fail(undefined);
    }

    setUncertain(owner, true);

    return client;
  });

const complete = (intent: Intent, combinedCode: string): void => {
  const { owner, dispatch, generation } = intent;
  const state = owner.state;

  if (!live(owner, generation) || !awaitingProof(state)) {
    return;
  }

  const { candidateEmail } = state;
  const code = Schema.decodeOption(EmailVerificationCode)(combinedCode);

  if (Option.isNone(code)) {
    change(owner, EmailReplacementViewState.InvalidCode({ candidateEmail }));

    return;
  }

  change(owner, EmailReplacementViewState.Completing({ candidateEmail }));
  owner.pending = Option.some((get) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.exit(prepareCompletion(intent, get));

      if (!live(owner, generation)) {
        return;
      }

      if (Exit.isFailure(prepared)) {
        clearReplacementAdmission(owner.binding);
        setUncertain(owner, false);
        change(owner, EmailReplacementViewState.PreparationUnavailable());

        return;
      }

      const result = yield* Effect.exit(
        prepared.value.emailAuthentication.completeEmailReplacement({
          payload: { candidateEmail, combinedCode: code.value },
        })
      );

      if (!live(owner, generation)) {
        return;
      }

      const next = Exit.isSuccess(result)
        ? EmailReplacementViewState.Replaced()
        : completionFailureState(result.cause, candidateEmail);

      const uncertain = EmailReplacementViewState.$is("Uncertain")(next);

      if (!uncertain) {
        clearReplacementAdmission(owner.binding);
      }

      setUncertain(owner, uncertain);
      change(owner, next);
    })
  );
  dispatch(undefined);
};

const retire = (owner: Owner, dispatch: Dispatch): void => {
  owner.generation += 1;
  owner.pending = Option.none();
  dispatch(Atom.Interrupt);
};

const settled = Predicate.or(
  Predicate.or(
    EmailReplacementViewState.$is("Uncertain"),
    EmailReplacementViewState.$is("Replaced")
  ),
  EmailReplacementViewState.$is("FreshPairingRequired")
);

const restart = (owner: Owner, dispatch: Dispatch, generation: number): void => {
  if (!live(owner, generation)) {
    return;
  }

  const state = owner.state;

  if (settled(state)) {
    return;
  }

  retire(owner, dispatch);
  change(
    owner,
    EmailReplacementViewState.$is("Completing")(state)
      ? EmailReplacementViewState.Uncertain()
      : editing()
  );
};

const mount = (owner: Owner, dispatch: Dispatch): (() => void) => {
  const resume = (): void => {
    owner.active = true;
    const admission = restoreReplacementAdmission(owner.binding);

    if (admission === "unavailable") {
      change(owner, EmailReplacementViewState.PreparationUnavailable());

      return;
    }

    setUncertain(owner, owner.uncertain || admission === "uncertain");
    change(owner, owner.uncertain ? EmailReplacementViewState.Uncertain() : editing());
  };

  resume();

  const dispose = (): void => {
    owner.active = false;
    retire(owner, dispatch);
    owner.state = EmailReplacementViewState.Disposed();
  };

  const hide = (): void => {
    dispose();
    owner.publish(EmailReplacementViewState.Disposed());
  };

  const restored = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      resume();
    }
  };

  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", restored);

  return (): void => {
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", restored);
    dispose();
  };
};

export const createReplacement = ({
  apiClient,
  publish,
  uncertain,
  onUncertain,
  binding,
  webAuthClient,
}: Pick<
  Owner,
  "apiClient" | "publish" | "uncertain" | "onUncertain" | "binding" | "webAuthClient"
>): Replacement => {
  const owner: Owner = {
    apiClient,
    publish,
    state: uncertain ? EmailReplacementViewState.Uncertain() : editing(),
    uncertain,
    onUncertain,
    binding,
    webAuthClient,
    active: false,
    generation: 0,
    pending: Option.none(),
  };

  const atom = apiClient.runtime.fn<void>()(
    (_input, get) =>
      Effect.suspend(() => {
        const pending = owner.pending;
        owner.pending = Option.none();

        return Option.match(pending, {
          onNone: () => Effect.interrupt,
          onSome: (work) => work(get),
        });
      }),
    { concurrent: false }
  );

  return {
    atom,
    mount: (dispatch: Dispatch): (() => void) => mount(owner, dispatch),
    actions: (dispatch: Dispatch): ReplacementActions => {
      const generation = owner.generation;

      return {
        request: (candidateEmail: string): void =>
          request({ owner, dispatch, generation }, candidateEmail),
        repeat: (): void => repeat(owner, dispatch, generation),
        complete: (combinedCode: string): void =>
          complete({ owner, dispatch, generation }, combinedCode),
        restart: (): void => restart(owner, dispatch, generation),
      };
    },
  };
};
