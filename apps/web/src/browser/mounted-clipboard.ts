import { type Duration, Effect, Exit, Option, Scope } from "effect";
import { type SensitiveClipboard, makeSensitiveClipboard } from "./sensitive-clipboard";

/**
 * Owns clipboard timers for one mounted disclosure. Disposal makes commands inert immediately;
 * asynchronous cleanup clears only the value still owned by this disclosure.
 */
export const makeMountedClipboard = (
  lifetime: Duration.Input
): Readonly<{ clipboard: SensitiveClipboard; dispose: () => void }> => {
  const scope = Scope.makeUnsafe();
  const clipboard = Effect.runSync(
    makeSensitiveClipboard(Option.fromUndefinedOr(globalThis.navigator.clipboard), lifetime).pipe(
      Scope.provide(scope)
    )
  );
  let active = true;
  return {
    clipboard: {
      reveal: (onExpired) => {
        if (active) {
          clipboard.reveal(() => {
            if (active) onExpired();
          });
        }
      },
      copy: (value, onCopied) => {
        if (active) {
          clipboard.copy(value, () => {
            if (active) onCopied();
          });
        }
      },
      clear: (value) => {
        if (active) clipboard.clear(value);
      },
    },
    dispose: () => {
      if (!active) return;
      active = false;
      Effect.runCallback(Scope.close(scope, Exit.void), { onExit: () => undefined });
    },
  };
};
