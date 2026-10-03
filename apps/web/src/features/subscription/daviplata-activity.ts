import { make as makeScopedAtom } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

/** Safe selection lock only; provider challenges and sensitive input never enter this atom. */
export const DaviplataAuthorizationLock = makeScopedAtom(() => Atom.make(false));
