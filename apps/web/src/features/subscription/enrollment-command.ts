import { Effect, Option } from "effect";
import { Atom } from "effect/reactivity";

/** Own one mounted enrollment command without retaining its transient inputs in atom arguments.
 * The registry owns execution; each offer is consumed once, and clearing discards unstarted work.
 */
export const makeEnrollmentCommand = <A, E>(): Readonly<{
  atom: Atom.AtomResultFn<void, A, E>;
  offer: (work: Effect.Effect<A, E>) => void;
  clear: () => void;
}> => {
  let pending = Option.none<Effect.Effect<A, E>>();
  const atom = Atom.fn<void>()(() =>
    Effect.suspend(() => {
      const offered = pending;
      pending = Option.none();
      return Option.match(offered, {
        onNone: () => Effect.interrupt,
        onSome: (work) => work,
      });
    })
  );
  return {
    atom,
    offer: (work: Effect.Effect<A, E>): void => {
      pending = Option.some(work);
    },
    clear: (): void => {
      pending = Option.none();
    },
  };
};
