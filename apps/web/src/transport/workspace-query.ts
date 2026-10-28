import { type AsyncResult, Atom } from "effect/reactivity";

/** Retain display data only within the current authentication registry. */
export const workspaceQueryRetention = { timeToLive: "1 minute" } as const;

/** Reuse a recent display snapshot; expired results reread before editing resumes. */
export const revalidateWorkspaceQuery = <A, E>(
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  query.pipe(
    Atom.swr({
      staleTime: "5 seconds",
      revalidateOnMount: true,
      revalidateOnFocus: true,
      focusSignal: Atom.windowFocusSignal,
    })
  );
