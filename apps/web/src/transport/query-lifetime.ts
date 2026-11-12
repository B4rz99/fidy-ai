import { authenticationEndedEvent } from "@/session/authentication-channel";
import { Atom, type AtomRegistry } from "effect/reactivity";

type QueryLifetime = Readonly<{
  active: () => boolean;
  observe: (settle: () => void) => () => void;
}>;

/** Logical retirement is synchronous; the React provider may dispose its registry later. */
const lifetime = Atom.make((get) => {
  let active = true;
  const pending = new Set<() => void>();
  const retire = (): void => {
    active = false;
    for (const settle of pending) settle();
    pending.clear();
  };
  if (typeof window !== "undefined") window.addEventListener(authenticationEndedEvent, retire);
  get.addFinalizer(() => {
    if (typeof window !== "undefined") window.removeEventListener(authenticationEndedEvent, retire);
    retire();
  });
  return {
    active: (): boolean => active,
    observe: (settle: () => void): (() => void) => {
      if (active) pending.add(settle);
      else settle();
      return () => pending.delete(settle);
    },
  };
}).pipe(Atom.keepAlive);

export const queryLifetime = (registry: AtomRegistry.AtomRegistry): QueryLifetime =>
  registry.get(lifetime);
