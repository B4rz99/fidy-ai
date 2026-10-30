import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { ReviewWorkspaceQuery } from "./decisions";

const focusSignal = Atom.readable((get) => {
  if (typeof window === "undefined") {
    return 0;
  }
  let version = 0;
  const visible = (): void => {
    if (document.visibilityState === "visible") {
      get.setSelf(++version);
    }
  };
  window.addEventListener("focus", visible);
  window.addEventListener("visibilitychange", visible);
  get.addFinalizer(() => {
    window.removeEventListener("focus", visible);
    window.removeEventListener("visibilitychange", visible);
  });
  return version;
});
const pollMilliseconds = 60000;
export const observeReviewQuery = (source: ReviewWorkspaceQuery): ReviewWorkspaceQuery =>
  Atom.transform(source, (get) => {
    const refresh = (): void => {
      if (!get.once(source).waiting) {
        get.refresh(source);
      }
    };
    get.once(focusSignal);
    get.subscribe(focusSignal, refresh);
    get.subscribe(source, (value) => get.setSelf(value));
    const timer = Effect.runFork(
      Effect.forever(Effect.sleep(pollMilliseconds).pipe(Effect.andThen(Effect.sync(refresh))))
    );
    get.addFinalizer(() => timer.interruptUnsafe());
    return get.once(source);
  });
