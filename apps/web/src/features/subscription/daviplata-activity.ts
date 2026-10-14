import { make as makeScopedAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

/** Contains only selection locks, never provider challenges or sensitive input. */
export const DaviplataAuthorizationLock = makeScopedAtom(() => Atom.make(false));
