import { Effect } from "effect";
import { type AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";

/** Retains a canonical query in its account registry; repeated reads explicitly refresh it. */
export const makeCanonicalRead = <A, E>({
  registry,
  query,
}: Readonly<{
  registry: AtomRegistry.AtomRegistry;
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
}>): Readonly<{ read: Effect.Effect<A, E>; dispose: () => void }> => {
  let hasRead = false;
  let active = true;
  const release = registry.mount(query);
  return {
    read: Effect.suspend(() => {
      if (!active) return Effect.interrupt;
      if (hasRead) registry.refresh(query);
      hasRead = true;
      return AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
    }),
    dispose: () => {
      active = false;
      release();
    },
  };
};
