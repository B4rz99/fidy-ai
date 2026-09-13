import { Duration, Effect, FiberHandle, Option, Ref, type Scope } from "effect";
import {
  type BrowserClipboard,
  ClipboardAccessFailed,
  readClipboardText,
  writeClipboardText,
} from "./clipboard";

const sensitiveClipboardMinutes = 10;

/** Maximum time Fidy leaves a copied sensitive value in the browser clipboard. */
export const sensitiveClipboardLifetime = Duration.minutes(sensitiveClipboardMinutes);

/**
 * Scoped commands for one mounted disclosure. `copy` reports success only after the browser write,
 * suppresses access failures, and replaces the previous copy expiry. `clear` erases only a matching
 * clipboard value. `reveal` owns an independent deadline; another reveal replaces that deadline.
 * Closing the owner interrupts every callback and makes the commands inert.
 */
export type SensitiveClipboard = Readonly<{
  reveal: (onExpired: () => void) => void;
  copy: (value: string, onCopied: () => void) => void;
  clear: (value: string) => void;
}>;

const clearMatching = (
  clipboard: Option.Option<BrowserClipboard>,
  value: string
): Effect.Effect<void> =>
  readClipboardText(clipboard).pipe(
    Effect.flatMap((current) =>
      current === value ? writeClipboardText(clipboard, "") : Effect.void
    ),
    Effect.ignore
  );

type LatestCopy = { current: Option.Option<CopyOwner> };

const writeOwned = (
  clipboard: Option.Option<BrowserClipboard>,
  value: string,
  latest: LatestCopy
): Effect.Effect<void, ClipboardAccessFailed> =>
  Option.match(clipboard, {
    onNone: () => Effect.fail(new ClipboardAccessFailed()),
    onSome: (available) =>
      Effect.suspend(() => {
        let active = true;
        const pendingWrite = available.writeText(value);
        return Effect.tryPromise({
          try: () =>
            pendingWrite.then(() =>
              active
                ? undefined
                : Option.match(latest.current, {
                    onNone: () => available.writeText(""),
                    onSome: (owner) => available.writeText(owner.value),
                  })
            ),
          catch: () => new ClipboardAccessFailed(),
        }).pipe(Effect.ensuring(Effect.sync(() => (active = false))));
      }),
  });

type CopyOwner = Readonly<{ value: string }>;

type ClipboardState = Readonly<{
  owner: Ref.Ref<Option.Option<CopyOwner>>;
  latest: LatestCopy;
  clipboard: Option.Option<BrowserClipboard>;
}>;

const clearCopied = (state: ClipboardState): Effect.Effect<void> =>
  Ref.getAndSet(state.owner, Option.none()).pipe(
    Effect.tap(() => Effect.sync(() => (state.latest.current = Option.none()))),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (owner) => clearMatching(state.clipboard, owner.value),
      })
    )
  );

const activateCopy = (state: ClipboardState, value: string): Effect.Effect<void> =>
  Ref.modify(state.owner, (current) => {
    if (Option.isSome(current) && current.value.value === value) {
      return [{ owner: current.value, replaced: Option.none<CopyOwner>() }, current] as const;
    }
    const owner: CopyOwner = { value };
    return [{ owner, replaced: current }, Option.some(owner)] as const;
  }).pipe(
    Effect.tap(({ owner }) => Effect.sync(() => (state.latest.current = Option.some(owner)))),
    Effect.tap(({ replaced }) =>
      Option.match(replaced, {
        onNone: () => Effect.void,
        onSome: (previous) => clearMatching(state.clipboard, previous.value),
      })
    ),
    Effect.asVoid
  );

const clearOwned = (state: ClipboardState, value: string): Effect.Effect<void> =>
  Ref.modify(state.owner, (current) => {
    if (Option.isSome(current) && current.value.value === value) {
      return [Option.some(current.value), Option.none()] as const;
    }
    return [Option.none<CopyOwner>(), current] as const;
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => clearMatching(state.clipboard, value),
        onSome: () =>
          Effect.sync(() => (state.latest.current = Option.none())).pipe(
            Effect.andThen(clearMatching(state.clipboard, value))
          ),
      })
    )
  );

/**
 * Creates scoped sensitive-value commands. Values are forgotten after expiry, explicit clearing,
 * or scope close and never enter the typed error channel or generic Cause rendering.
 */
export const makeSensitiveClipboard = (
  clipboard: Option.Option<BrowserClipboard>,
  lifetime: Duration.Input
): Effect.Effect<SensitiveClipboard, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* Ref.make(Option.none<CopyOwner>());
    const state: ClipboardState = { owner, latest: { current: Option.none() }, clipboard };
    yield* Effect.addFinalizer(() => clearCopied(state));
    const copyHandle = yield* FiberHandle.make<void, never>();
    const copyRun = yield* FiberHandle.runtime(copyHandle)<never>();
    const revealRun = yield* FiberHandle.makeRuntime<never, never, void>();

    return {
      reveal: (onExpired) => {
        revealRun(
          Effect.sleep(lifetime).pipe(
            Effect.andThen(Effect.sync(onExpired)),
            Effect.andThen(FiberHandle.clear(copyHandle)),
            Effect.andThen(clearCopied(state))
          )
        );
      },
      copy: (value, onCopied) => {
        copyRun(
          activateCopy(state, value).pipe(
            Effect.flatMap(() =>
              writeOwned(clipboard, value, state.latest).pipe(
                Effect.match({ onFailure: () => undefined, onSuccess: onCopied })
              )
            ),
            Effect.andThen(Effect.sleep(lifetime)),
            Effect.andThen(clearCopied(state))
          )
        );
      },
      clear: (value) => copyRun(clearOwned(state, value)),
    };
  });
