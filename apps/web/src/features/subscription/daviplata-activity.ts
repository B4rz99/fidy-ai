import { make as makeScopedAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

export const DaviplataAuthorizationLock = makeScopedAtom(() => Atom.make(false));
