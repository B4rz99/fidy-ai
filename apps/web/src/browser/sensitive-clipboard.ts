import { Duration, Effect, FiberHandle, Function, Option, type Scope } from "effect";
import { type BrowserClipboard, ClipboardAccessFailed } from "./clipboard";

const sensitiveClipboardMinutes = 10;

/** Expiry interval for copied sensitive values. */
export const sensitiveClipboardLifetime = Duration.minutes(sensitiveClipboardMinutes);

/** Idempotent release of one exact copy; equal text never grants ownership. */
export type CopyRelease = Readonly<{ release: () => void }>;

/**
 * Mounted disclosure commands. Copied acknowledges only a successful current write. Reveal and
 * copy deadlines are independent. Cleanup is best effort: browser read/write is not atomic and
 * neither release nor scope closure proves physical clipboard erasure.
 */
export type SensitiveClipboard = Readonly<{
  reveal: (onExpired: () => void) => void;
  copy: (value: string, onCopied?: () => void) => CopyRelease;
}>;

type CopyOwner = { value: Option.Option<string> };
type ClipboardState = {
  open: boolean;
  generation: number;
  current: Option.Option<CopyOwner>;
  clipboard: Option.Option<BrowserClipboard>;
};
type Run = (effect: Effect.Effect<void>) => void;

const owns = (state: ClipboardState, owner: CopyOwner): boolean =>
  state.open && Option.isSome(state.current) && state.current.value === owner;

const retire = (state: ClipboardState): Option.Option<string> => {
  const previous = state.current;
  state.current = Option.none();
  if (Option.isNone(previous)) return Option.none();
  const value = previous.value.value;
  previous.value.value = Option.none();
  return value;
};

const writeStillCurrent = (
  state: ClipboardState,
  owner: Option.Option<CopyOwner>,
  generation: number
): boolean =>
  Option.isSome(owner)
    ? owns(state, owner.value)
    : state.generation === generation && Option.isNone(state.current);

const latestValue = (state: ClipboardState): Option.Option<string> => {
  if (!state.open || Option.isNone(state.current)) return Option.none();
  return state.current.value.value;
};

const write = async (
  state: ClipboardState,
  value: string,
  owner: Option.Option<CopyOwner>
): Promise<void> => {
  const generation = state.generation;
  if (Option.isNone(state.clipboard)) throw new ClipboardAccessFailed();
  const available = state.clipboard.value;
  await available.writeText(value);
  if (writeStillCurrent(state, owner, generation)) return;
  const observed = await available.readText();
  if (observed !== value) return;
  // Choose repair only after observing obsolete text. A delayed repair is itself fenced;
  // it never publishes Copied or restarts the owner's original deadline.
  const latest = latestValue(state);
  if (Option.isSome(latest)) {
    await write(state, latest.value, state.current);
  } else if (value !== "") {
    await write(state, "", Option.none());
  }
};

const release = (state: ClipboardState, owner: CopyOwner): void => {
  if (!owns(state, owner)) return;
  const value = retire(state);
  const generation = state.generation;
  const clipboard = state.clipboard;
  if (Option.isNone(clipboard) || Option.isNone(value)) return;
  // Native operations can outlive the scope. Recheck local authority after the read.
  Promise.resolve()
    .then(() => clipboard.value.readText())
    .then((observed) => {
      if (state.generation !== generation || Option.isSome(state.current)) return;
      if (observed === value.value) return write(state, "", Option.none());
    })
    .catch(() => undefined);
};

const copy =
  (state: ClipboardState, run: Run, lifetime: Duration.Input): SensitiveClipboard["copy"] =>
  (value, onCopied) => {
    if (!state.open) return { release: () => undefined };
    retire(state);
    state.generation += 1;
    const owner: CopyOwner = { value: Option.some(value) };
    state.current = Option.some(owner);
    run(
      Effect.tryPromise({
        try: () => write(state, value, Option.some(owner)),
        catch: () => new ClipboardAccessFailed(),
      }).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.sync(() => release(state, owner)),
          onSuccess: () => {
            if (!owns(state, owner)) return Effect.void;
            return Effect.sync(() => onCopied?.()).pipe(
              Effect.andThen(Effect.sleep(lifetime)),
              Effect.andThen(Effect.sync(() => release(state, owner)))
            );
          },
        })
      )
    );
    return { release: () => release(state, owner) };
  };

const reveal =
  (state: ClipboardState, run: Run, lifetime: Duration.Input): SensitiveClipboard["reveal"] =>
  (onExpired) => {
    if (!state.open) return;
    run(
      Effect.sleep(lifetime).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!state.open) return;
            const revealedCopy = state.current;
            onExpired();
            if (Option.isSome(revealedCopy)) release(state, revealedCopy.value);
          })
        )
      )
    );
  };

const close = (state: ClipboardState): Effect.Effect<void> =>
  Effect.sync(() => {
    if (Option.isSome(state.current)) release(state, state.current.value);
    state.open = false;
  });

/** Creates a private owner; scope closure disables admission and retires its exact copy. */
export const makeSensitiveClipboard: {
  (
    clipboard: Option.Option<BrowserClipboard>,
    lifetime: Duration.Input
  ): Effect.Effect<SensitiveClipboard, never, Scope.Scope>;
  (
    lifetime: Duration.Input
  ): (
    clipboard: Option.Option<BrowserClipboard>
  ) => Effect.Effect<SensitiveClipboard, never, Scope.Scope>;
} = Function.dual(2, (clipboard: Option.Option<BrowserClipboard>, lifetime: Duration.Input) =>
  Effect.gen(function* () {
    const state: ClipboardState = { open: true, generation: 0, current: Option.none(), clipboard };
    const copyRun = yield* FiberHandle.makeRuntime<never, never, void>();
    const revealRun = yield* FiberHandle.makeRuntime<never, never, void>();
    yield* Effect.addFinalizer(() => close(state));
    return { copy: copy(state, copyRun, lifetime), reveal: reveal(state, revealRun, lifetime) };
  })
);
