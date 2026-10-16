import { type AsyncResult, Atom } from "effect/reactivity";

/** Retain display data only within the current authentication registry. */
export const workspaceQueryRetention = { timeToLive: "1 minute" } as const;

/** Show the last display result immediately, then reread before editing resumes. */
export const revalidateWorkspaceQuery = <A, E>(
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  query.pipe(
    Atom.swr({
      staleTime: "0 seconds",
      revalidateOnMount: true,
      revalidateOnFocus: "always",
      focusSignal: Atom.windowFocusSignal,
    })
  );
