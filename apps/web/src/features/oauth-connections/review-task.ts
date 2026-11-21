import { authenticationEndedEvent } from "@/session/authentication-channel";
import { Data, DateTime, Duration, Effect, Match, Option, Schema, Struct } from "effect";
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

export type ReviewTaskState = Data.TaggedEnum<{
  Reviewing: Selection;
  Connecting: Selection;
  Cancelling: Selection;
  Disposed: {};
  Loading: {};
  Unavailable: {};
  Redirecting: {};
  Cancelled: {};
  Uncertain: {};
  CancellationUnconfirmed: {};
}>;

export const ReviewTaskState = Data.taggedEnum<ReviewTaskState>();

type ReviewingState = Data.TaggedEnum.Value<ReviewTaskState, "Reviewing">;

export type ReviewTaskActions = Readonly<{
  toggle: (scope: PATScope, checked: boolean) => void;
  select: (days: PATLifetimeDays) => void;
  connect: () => void;
  cancel: () => void;
  readAgain: () => void;
}>;

type Decision = Data.TaggedEnum<{
  ReadAgain: Readonly<{
    requestId: OAuthReview["requestId"];
    completed: (review: OAuthReview) => void;
    failed: () => void;
  }>;
  Connect: Readonly<{
    choice: OAuthReviewChoice;
    completed: (callback: string) => void;
    failed: () => void;
  }>;
  Cancel: Readonly<{
    requestId: OAuthReview["requestId"];
    completed: () => void;
    failed: () => void;
  }>;
}>;

const Decision = Data.taggedEnum<Decision>();

type Dispatch = (decision: Decision) => void;

type Owner = {
  requestId: OAuthReview["requestId"];
  current: ReviewTaskState;
  active: boolean;
  publish: (state: ReviewTaskState) => void;
  navigate: (callback: string) => void;
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

        yield* Decision.$match(decision, {
          ReadAgain: ({ requestId, completed }) =>
            api.oauthReview.review({ query: { requestId } }).pipe(Effect.map(completed)),
          Connect: ({ choice, completed }) =>
            api.oauthReview
              .connect({ payload: choice })
              .pipe(Effect.map(Struct.get("callback")), Effect.map(completed)),
          Cancel: ({ requestId, completed }) =>
            api.oauthReview
              .cancel({ payload: { requestId } })
              .pipe(Effect.andThen(Effect.sync(completed))),
        });
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

const reviewing = (owner: Owner, rendered: ReviewTaskState): Option.Option<ReviewingState> =>
  owner.active && owner.current === rendered && ReviewTaskState.$is("Reviewing")(rendered)
    ? Option.some(rendered)
    : Option.none();

type Admission = Readonly<{
  current: () => boolean;
  complete: (next: ReviewTaskState) => void;
}>;

const admit = (owner: Owner, admitted: ReviewTaskState): Admission => {
  publish(owner, admitted);

  const current = (): boolean => owner.active && owner.current === admitted;

  return {
    current,
    complete: (next: ReviewTaskState): void => {
      if (current()) publish(owner, next);
    },
  };
};

const connect = (owner: Owner, rendered: ReviewTaskState, dispatch: Dispatch): void =>
  Option.match(
    Option.flatMap(reviewing(owner, rendered), (selection) =>
      Option.map(choose(selection), (choice) => ({ selection, choice }))
    ),
    {
      onNone: () => undefined,
      onSome: ({ selection, choice }) => {
        const admitted = admit(owner, ReviewTaskState.Connecting(selection));

        dispatch(
          Decision.Connect({
            choice,
            completed: (callback): void => {
              if (!admitted.current()) return;
              owner.navigate(callback);
              admitted.complete(ReviewTaskState.Redirecting());
            },
            failed: (): void => admitted.complete(ReviewTaskState.Uncertain()),
          })
        );
      },
    }
  );

const cancel = (owner: Owner, rendered: ReviewTaskState, dispatch: Dispatch): void =>
  Option.match(reviewing(owner, rendered), {
    onNone: () => undefined,
    onSome: (selection) => {
      const admitted = admit(owner, ReviewTaskState.Cancelling(selection));

      dispatch(
        Decision.Cancel({
          requestId: selection.review.requestId,
          completed: (): void => admitted.complete(ReviewTaskState.Cancelled()),
          failed: (): void => admitted.complete(ReviewTaskState.CancellationUnconfirmed()),
        })
      );
    },
  });

export const initialReviewSelection = (review: OAuthReview): ReviewingState =>
  ReviewTaskState.Reviewing({ review, scopes: review.scopes, days: defaultPATLifetimeDays });

const edit = (
  owner: Owner,
  rendered: ReviewTaskState,
  update: (selection: Selection) => Selection
): void => {
  Option.map(reviewing(owner, rendered), (selection) =>
    publish(owner, ReviewTaskState.Reviewing(update(selection)))
  );
};

const resume = (previous: ReviewTaskState): ReviewTaskState =>
  Match.value(previous).pipe(
    Match.tag("Connecting", () => ReviewTaskState.Uncertain()),
    Match.tag("Cancelling", () => ReviewTaskState.CancellationUnconfirmed()),
    Match.tag("Loading", () => ReviewTaskState.Unavailable()),
    Match.orElse((settled): ReviewTaskState => ({ ...settled }))
  );

const mount = (owner: Owner): (() => void) => {
  owner.active = true;
  const previous = owner.current;
  publish(owner, resume(previous));

  const retire = (): void => {
    owner.active = false;
    publish(owner, ReviewTaskState.Disposed());
  };

  window.addEventListener("pagehide", retire);
  window.addEventListener(authenticationEndedEvent, retire);

  return (): void => {
    window.removeEventListener("pagehide", retire);
    window.removeEventListener(authenticationEndedEvent, retire);
    owner.active = false;
  };
};

const readAgain = (owner: Owner, state: ReviewTaskState, dispatch: Dispatch): void => {
  if (
    !owner.active ||
    owner.current !== state ||
    !(
      ReviewTaskState.$is("CancellationUnconfirmed")(state) ||
      ReviewTaskState.$is("Unavailable")(state)
    )
  ) {
    return;
  }

  const reading = ReviewTaskState.Loading();
  publish(owner, reading);
  dispatch(
    Decision.ReadAgain({
      requestId: owner.requestId,
      completed: (review): void => {
        if (owner.active && owner.current === reading) {
          publish(owner, initialReviewSelection(review));
        }
      },
      failed: (): void => {
        if (owner.active && owner.current === reading) {
          publish(owner, ReviewTaskState.Unavailable());
        }
      },
    })
  );
};

export type ReviewTask = Readonly<{
  atom: Atom.AtomResultFn<Decision, void, never>;
  mount: () => () => void;
  actions: (state: ReviewTaskState, dispatch: Dispatch) => ReviewTaskActions;
}>;

export const openReviewTask = ({
  client,
  initial,
  onChange,
  navigate,
}: Readonly<{
  client: WebAuthClient;
  initial: ReturnType<typeof initialReviewSelection>;
  onChange: Owner["publish"];
  navigate: Owner["navigate"];
}>): ReviewTask => {
  const owner: Owner = {
    requestId: initial.review.requestId,
    current: initial,
    active: false,
    publish: onChange,
    navigate,
  };

  return {
    atom: makeDecision(client),
    mount: () => mount(owner),
    actions: (state, dispatch) => ({
      toggle: (scope, checked): void =>
        edit(owner, state, (selection) => {
          const scopes = new Set(selection.scopes);

          return {
            ...selection,
            scopes: selection.review.scopes.filter((candidate) =>
              candidate === scope ? checked : scopes.has(candidate)
            ),
          };
        }),
      select: (days): void => edit(owner, state, (selection) => ({ ...selection, days })),
      connect: (): void => connect(owner, state, dispatch),
      cancel: (): void => cancel(owner, state, dispatch),
      readAgain: (): void => readAgain(owner, state, dispatch),
    }),
  };
};
