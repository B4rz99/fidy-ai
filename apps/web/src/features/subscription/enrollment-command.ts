import { Effect, Option } from "effect";
import { Atom } from "effect/reactivity";

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
