import { DateTime, Duration, Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import {
  type OAuthReview,
  OAuthReviewChoice,
  type PATLifetimeDays,
  type PATScope,
  type WebAuthClient,
  defaultPATLifetimeDays,
} from "@/transport/client";

type Selection = Readonly<{
  review: OAuthReview;
  scopes: ReadonlyArray<PATScope>;
  days: PATLifetimeDays;
}>;
export type ReviewTaskState =
  | (Selection & Readonly<{ _tag: "Reviewing" | "Connecting" | "Cancelling" }>)
  | Readonly<{ _tag: "Redirecting" }>
  | Readonly<{ _tag: "Cancelled" }>
  | Readonly<{ _tag: "Uncertain" }>
  | Readonly<{ _tag: "CancellationUnconfirmed" }>;
export type ReviewTaskActions = Readonly<{
  toggle: (scope: PATScope, checked: boolean) => void;
  select: (days: PATLifetimeDays) => void;
  connect: () => void;
  cancel: () => void;
}>;
type Decision =
  | Readonly<{
      _tag: "Connect";
      choice: OAuthReviewChoice;
      completed: (callback: string) => void;
      failed: () => void;
    }>
  | Readonly<{
      _tag: "Cancel";
      requestId: OAuthReview["requestId"];
      completed: () => void;
      failed: () => void;
    }>;
type Dispatch = (decision: Decision) => void;
type Owner = {
  current: ReviewTaskState;
  active: boolean;
  publish: (state: ReviewTaskState) => void;
};
const publish = (owner: Owner, state: ReviewTaskState): void => {
  owner.current = state;
  owner.publish(state);
};
const makeDecision = (client: WebAuthClient): Atom.AtomResultFn<Decision, void, never> =>
  client.runtime.fn<Decision>()(
    (decision) =>
      Effect.gen(function* () {
        const api = yield* client;
        if (decision._tag === "Connect") {
          const result = yield* api.oauthReview.connect({ payload: decision.choice });
          yield* Effect.sync(() => decision.completed(result.callback));
        } else {
          yield* api.oauthReview.cancel({ payload: { requestId: decision.requestId } });
          yield* Effect.sync(decision.completed);
        }
      }).pipe(Effect.catchCause(() => Effect.sync(decision.failed))),
    { concurrent: false }
  );
const choose = (selection: Selection): Option.Option<OAuthReviewChoice> =>
  Schema.decodeOption(Schema.toType(OAuthReviewChoice))({
    requestId: selection.review.requestId,
    scopes: selection.scopes,
    lifetimeDays: selection.days,
    reviewedAt: selection.review.reviewedAt,
    expiresAt: DateTime.addDuration(selection.review.reviewedAt, Duration.days(selection.days)),
  });
const decide = (
  owner: Owner,
  {
    rendered,
    dispatch,
    connect,
  }: Readonly<{ rendered: ReviewTaskState; dispatch: Dispatch; connect: boolean }>
): void => {
  if (!owner.active || owner.current !== rendered || rendered._tag !== "Reviewing") return;
  const choice = choose(rendered);
  if (connect && Option.isNone(choice)) return;
  const admitted: ReviewTaskState = { ...rendered, _tag: connect ? "Connecting" : "Cancelling" };
  publish(owner, admitted);
  const complete = (next: ReviewTaskState): void => {
    if (owner.active && owner.current === admitted) publish(owner, next);
  };
  if (connect) {
    dispatch({
      _tag: "Connect",
      choice: Option.getOrThrow(choice),
      completed: (callback): void => {
        if (!owner.active || owner.current !== admitted) return;
        window.location.assign(callback);
        complete({ _tag: "Redirecting" });
      },
      failed: (): void => complete({ _tag: "Uncertain" }),
    });
  } else {
    dispatch({
      _tag: "Cancel",
      requestId: rendered.review.requestId,
      completed: (): void => complete({ _tag: "Cancelled" }),
      failed: (): void => complete({ _tag: "CancellationUnconfirmed" }),
    });
  }
};
export const initialReviewSelection = (review: OAuthReview): ReviewTaskState => ({
  _tag: "Reviewing",
  review,
  scopes: review.scopes,
  days: defaultPATLifetimeDays,
});
export const makeReviewTask = ({
  client,
  initial,
  onChange,
}: Readonly<{
  client: WebAuthClient;
  initial: ReviewTaskState;
  onChange: Owner["publish"];
}>): Readonly<{
  atom: ReturnType<typeof makeDecision>;
  mount: () => () => void;
  actions: (state: ReviewTaskState, dispatch: Dispatch) => ReviewTaskActions;
}> => {
  const owner: Owner = { current: initial, active: false, publish: onChange };
  const edit = (rendered: ReviewTaskState, update: (selection: Selection) => Selection): void => {
    if (!owner.active || owner.current !== rendered || rendered._tag !== "Reviewing") return;
    publish(owner, { ...update(rendered), _tag: "Reviewing" });
  };
  return {
    atom: makeDecision(client),
    mount: () => {
      owner.active = true;
      return (): void => {
        owner.active = false;
      };
    },
    actions: (state, dispatch) => ({
      toggle: (scope, checked): void =>
        edit(state, (selection) => ({
          ...selection,
          scopes: selection.review.scopes.filter((candidate) =>
            candidate === scope ? checked : selection.scopes.includes(candidate)
          ),
        })),
      select: (days): void => edit(state, (selection) => ({ ...selection, days })),
      connect: (): void => decide(owner, { rendered: state, dispatch, connect: true }),
      cancel: (): void => decide(owner, { rendered: state, dispatch, connect: false }),
    }),
  };
};
