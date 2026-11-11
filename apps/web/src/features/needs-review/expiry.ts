import { useAtomValue } from "@effect/atom-react";
import { DateTime } from "effect";
import { Atom } from "effect/reactivity";
import type { Item } from "./model";

const maximumTimerMilliseconds = 2_147_483_647;
/** One registry-owned timer per deadline; long retention periods rearm safely. */
const deadlineSnapshot = Atom.family((deadline: number) =>
  Atom.make((get): number => {
    const remaining = deadline - DateTime.toEpochMillis(DateTime.nowUnsafe());
    if (remaining <= 0) return 0;
    const resume = (): void => get.refreshSelf();
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    get.addFinalizer(() => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    });
    const timer = window.setTimeout(
      () => get.refreshSelf(),
      Math.min(remaining, maximumTimerMilliseconds)
    );
    get.addFinalizer(() => window.clearTimeout(timer));
    return deadline;
  })
);
export const reviewHasExpired = (item: Item): boolean =>
  DateTime.toEpochMillis(item.expiresAt) <= DateTime.toEpochMillis(DateTime.nowUnsafe());
export const useReviewExpired = (item: Item): boolean => {
  const expired = useAtomValue(deadlineSnapshot(DateTime.toEpochMillis(item.expiresAt)));
  return expired === 0 || reviewHasExpired(item);
};

/** Wake page-local search when the next retained original or draft reaches its deadline. */
export const useReviewPageExpiry = (items: ReadonlyArray<Pick<Item, "expiresAt">>): void => {
  const current = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const next = items.reduce((nearest, item) => {
    const deadline = DateTime.toEpochMillis(item.expiresAt);
    return deadline > current ? Math.min(nearest, deadline) : nearest;
  }, Infinity);
  useAtomValue(deadlineSnapshot(Number.isFinite(next) ? next : 0));
};
