import type { EmailReplacementViewState } from "./view";
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
  ReturnType<Context.Service.Shape<WebAuthClient>["browserSession"]["binding"]>
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
const editing: EmailReplacementViewState = { _tag: "Editing", feedback: "none" };
const live = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;
const change = (owner: Owner, state: EmailReplacementViewState): void => {
  owner.state = state;
  owner.publish(state);
};
const failureState = (
  cause: Cause.Cause<unknown>,
  candidateEmail: EmailAddressType,
  completing: boolean
): EmailReplacementViewState => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    if (
      Schema.is(EmailReplacementFreshPairingRequiredApi)(failure.value) ||
      Predicate.isTagged(failure.value, "Unauthenticated")
    ) {
      return { _tag: "FreshPairingRequired" };
    }
    if (completing && Schema.is(EmailReplacementInvalidApi)(failure.value)) {
      return { _tag: "InvalidCode", candidateEmail };
    }
  }
  return completing
    ? { _tag: "Uncertain" }
    : { _tag: "Editing", feedback: "request-unavailable", draftEmail: candidateEmail };
};
const runRequest = (
  { owner, dispatch }: Pick<Intent, "owner" | "dispatch">,
  candidateEmail: EmailAddressType,
  draftEmail: string
): void => {
  owner.generation += 1;
  const generation = owner.generation;
  change(owner, { _tag: "Requesting", candidateEmail });
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
      if (!live(owner, generation)) return;
      const next: EmailReplacementViewState = Exit.isSuccess(result)
        ? { _tag: "AwaitingCode", candidateEmail }
        : failureState(result.cause, candidateEmail, false);
      change(
        owner,
        next._tag === "Editing" && next.feedback === "request-unavailable"
          ? { ...next, draftEmail }
          : next
      );
    })
  );
  dispatch(undefined);
};
const request = ({ owner, dispatch, generation }: Intent, candidateEmail: string): void => {
  if (!live(owner, generation) || owner.state._tag !== "Editing") return;
  const candidate = Schema.decodeOption(EmailAddress)(candidateEmail);
  if (Option.isNone(candidate)) {
    change(owner, { _tag: "Editing", feedback: "invalid-candidate" });
    return;
  }
  runRequest({ owner, dispatch }, candidate.value, candidateEmail);
};
const repeat = (owner: Owner, dispatch: Dispatch, generation: number): void => {
  if (!live(owner, generation)) return;
  const current = owner.state;
  if (current._tag === "AwaitingCode" || current._tag === "InvalidCode") {
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
): Effect.Effect<Context.Service.Shape<FidyClient>, BindingFailure | void> =>
  Effect.gen(function* () {
    const context = yield* get.result(owner.webAuthClient.runtime, { suspendOnWaiting: true });
    const authentication = Context.get(context, owner.webAuthClient);
    const observation = yield* authentication.browserSession.binding({ query: {} });
    if (!live(owner, generation) || observation.binding !== owner.binding) {
      return yield* Effect.fail(undefined);
    }
    const client = yield* owner.apiClient;
    if (!live(owner, generation)) return yield* Effect.interrupt;
    if (!retainReplacementAdmission(owner.binding)) return yield* Effect.fail(undefined);
    setUncertain(owner, true);
    return client;
  });
const complete = (intent: Intent, combinedCode: string): void => {
  const { owner, dispatch, generation } = intent;
  const state = owner.state;
  if (!live(owner, generation) || (state._tag !== "AwaitingCode" && state._tag !== "InvalidCode")) {
    return;
  }
  const { candidateEmail } = state;
  const code = Schema.decodeOption(EmailVerificationCode)(combinedCode);
  if (Option.isNone(code)) {
    change(owner, { _tag: "InvalidCode", candidateEmail });
    return;
  }
  change(owner, { _tag: "Completing", candidateEmail });
  owner.pending = Option.some((get) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.exit(prepareCompletion(intent, get));
      if (!live(owner, generation)) return;
      if (Exit.isFailure(prepared)) {
        clearReplacementAdmission(owner.binding);
        setUncertain(owner, false);
        change(owner, { _tag: "PreparationUnavailable" });
        return;
      }
      const result = yield* Effect.exit(
        prepared.value.emailAuthentication.completeEmailReplacement({
          payload: { candidateEmail, combinedCode: code.value },
        })
      );
      if (!live(owner, generation)) return;
      const next = Exit.isSuccess(result)
        ? { _tag: "Replaced" as const }
        : failureState(result.cause, candidateEmail, true);
      if (next._tag !== "Uncertain") clearReplacementAdmission(owner.binding);
      setUncertain(owner, next._tag === "Uncertain");
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
const restart = (owner: Owner, dispatch: Dispatch, generation: number): void => {
  if (!live(owner, generation)) return;
  const { _tag } = owner.state;
  if (_tag === "Uncertain" || _tag === "Replaced" || _tag === "FreshPairingRequired") return;
  retire(owner, dispatch);
  change(owner, _tag === "Completing" ? { _tag: "Uncertain" } : editing);
};
const mount = (owner: Owner, dispatch: Dispatch): (() => void) => {
  const resume = (): void => {
    owner.active = true;
    const admission = restoreReplacementAdmission(owner.binding);
    if (admission === "unavailable") {
      change(owner, { _tag: "PreparationUnavailable" });
      return;
    }
    setUncertain(owner, owner.uncertain || admission === "uncertain");
    change(owner, owner.uncertain ? { _tag: "Uncertain" } : { ...editing });
  };
  resume();
  const dispose = (): void => {
    owner.active = false;
    retire(owner, dispatch);
    owner.state = { _tag: "Disposed" };
  };
  const hide = (): void => {
    dispose();
    owner.publish({ _tag: "Disposed" });
  };
  const restored = (event: PageTransitionEvent): void => {
    if (event.persisted) resume();
  };
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", restored);
  return (): void => {
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", restored);
    dispose();
  };
};
export const makeReplacement = ({
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
    state: uncertain ? { _tag: "Uncertain" } : editing,
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
