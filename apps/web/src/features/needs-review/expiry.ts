import { useAtomValue } from "@effect/atom-react";
import { DateTime } from "effect";
import { Atom } from "effect/reactivity";
import type { Item } from "./model";

const maximumTimerMilliseconds = 2_147_483_647;
/** One registry-owned timer per deadline; long retention periods rearm safely. */
const deadlineExpired = Atom.family((deadline: number) =>
  Atom.make((get): boolean => {
    const remaining = deadline - DateTime.toEpochMillis(DateTime.nowUnsafe());
    if (remaining <= 0) return true;
    const timer = window.setTimeout(
      () => get.refreshSelf(),
      Math.min(remaining, maximumTimerMilliseconds)
    );
    get.addFinalizer(() => window.clearTimeout(timer));
    return false;
  })
);
export const reviewHasExpired = (item: Item): boolean =>
  DateTime.toEpochMillis(item.expiresAt) <= DateTime.toEpochMillis(DateTime.nowUnsafe());
export const useReviewExpired = (item: Item): boolean => {
  const expired = useAtomValue(deadlineExpired(DateTime.toEpochMillis(item.expiresAt)));
  return expired || reviewHasExpired(item);
};
