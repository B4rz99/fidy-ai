import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Clock, type DateTime, Effect, Option } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";
import type {
  ConnectionAttemptReference,
  ConnectionContinuationReview,
  WebAuthClient,
} from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";

type Review = typeof ConnectionContinuationReview.Type;
type Attempt = typeof ConnectionAttemptReference.Type;
type Lifetime = Readonly<{
  attach: (dispose: () => void) => () => void;
  active: () => boolean;
  generation: () => number;
}>;
const makeLifetime = (): Lifetime => {
  let active = false;
  let generation = 0;
  return {
    active: () => active,
    generation: () => generation,
    attach: (dispose) => {
      active = true;
      return () => {
        active = false;
        generation += 1;
        dispose();
      };
    },
  };
};
export const continuationDeadline = (review: Review): DateTime.Utc =>
  review.authorization?.expiresAt ?? review.expiresAt;
const now = (): number => Effect.runSync(Clock.currentTimeMillis);
const freshReview = (result: CanonicalQueryState<Review, unknown>): Option.Option<Review> =>
  result._tag === "Ready" &&
  !result.waiting &&
  Option.isNone(result.refreshFailure) &&
  continuationDeadline(result.value).epochMilliseconds > now()
    ? Option.some(result.value)
    : Option.none();

const canRefresh = (result: CanonicalQueryState<Review, unknown>): boolean =>
  !result.waiting &&
  (result._tag !== "Ready" || continuationDeadline(result.value).epochMilliseconds > now());

type Submission = Readonly<{ generation: number; deadline: number }>;
const prepareContinuation = (
  {
    client,
    attempt,
    lifetime,
    refresh,
  }: Readonly<{
    client: WebAuthClient;
    attempt: Attempt;
    lifetime: Lifetime;
    refresh: () => void;
  }>,
  submission: Submission
): Effect.Effect<boolean> => {
  const current = (): boolean =>
    lifetime.active() &&
    lifetime.generation() === submission.generation &&
    submission.deadline > now();
  return Effect.suspend(() =>
    current()
      ? client.pipe(
          Effect.flatMap((api) => api.connectionBrowser.begin({ payload: { attempt } })),
          Effect.tap(() =>
            Effect.sync(() => {
              if (current()) refresh();
            })
          ),
          Effect.as(false),
          Effect.catchCause(() => Effect.succeed(true))
        )
      : Effect.succeed(false)
  );
};

type Continuation = Readonly<{
  result: CanonicalQueryState<Review, unknown>;
  busy: boolean;
  uncertain: boolean;
  submitted: boolean;
  mounted: RefCallback<HTMLDivElement>;
  begin: () => void;
  refresh: () => void;
  canFollow: (review: Review) => boolean;
}>;

/** Owns one mounted locator/session; a dispatched Begin remains spent even after an old Ready read. */
export const useContinuation = (attempt: Attempt): Continuation => {
  const { webAuthClient: client, registry } = useRouter().options.context;
  const [lifetime] = useState(makeLifetime);
  const [submitted] = useState(() => Atom.make(false));
  const [query] = useState(() =>
    client.query("connectionBrowser", "review", { query: { attempt }, timeToLive: "0 seconds" })
  );
  const [command] = useState(() =>
    client.runtime.fn<Submission>()(
      (submission) =>
        prepareContinuation(
          { client, attempt, lifetime, refresh: () => registry.refresh(query) },
          submission
        ),
      { concurrent: false }
    )
  );
  const execution = useAtomValue(command).pipe(presentCanonicalQuery);
  const result = useAtomValue(query).pipe(presentCanonicalQuery);
  const mounted = useCallback(
    (_node: HTMLDivElement): (() => void) =>
      lifetime.attach(() => registry.set(command, Atom.Interrupt)),
    [command, lifetime, registry]
  );
  return {
    result,
    busy: execution.waiting,
    uncertain: execution._tag === "Ready" && execution.value,
    submitted: useAtomValue(submitted),
    mounted,
    begin: () => {
      const fresh = freshReview(presentCanonicalQuery(registry.get(query)));
      if (!lifetime.active() || registry.get(submitted)) return;
      if (Option.isNone(fresh) || fresh.value.phase !== "ready") {
        return;
      }
      registry.set(submitted, true);
      registry.set(command, {
        generation: lifetime.generation(),
        deadline: fresh.value.expiresAt.epochMilliseconds,
      });
    },
    refresh: () => {
      if (
        lifetime.active() &&
        !registry.get(command).waiting &&
        canRefresh(presentCanonicalQuery(registry.get(query)))
      ) {
        registry.refresh(query);
      }
    },
    canFollow: (review) =>
      lifetime.active() &&
      !registry.get(command).waiting &&
      Option.exists(
        freshReview(presentCanonicalQuery(registry.get(query))),
        (fresh) => fresh === review
      ),
  };
};
