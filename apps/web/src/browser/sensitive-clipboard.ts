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

type CopyOwner = { value: Option.Option<string>; prior: Option.Option<string>; written: boolean };
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
  previous.value.prior = Option.none();
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

const repair = (state: ClipboardState, obsolete: string, observed: string): Promise<void> => {
  if (observed !== obsolete) return Promise.resolve();
  const latest = latestValue(state);
  if (Option.isSome(latest)) return write(state, latest.value, state.current);
  return obsolete === "" ? Promise.resolve() : write(state, "", Option.none());
};

const write = (
  state: ClipboardState,
  value: string,
  owner: Option.Option<CopyOwner>
): Promise<void> => {
  const generation = state.generation;
  if (Option.isNone(state.clipboard)) return Promise.reject(new ClipboardAccessFailed());
  const available = state.clipboard.value;
  return Promise.resolve()
    .then(() => available.writeText(value))
    .then(() => {
      if (writeStillCurrent(state, owner, generation)) return undefined;
      return available.readText().then((observed) => repair(state, value, observed));
    });
};

const release = (state: ClipboardState, owner: CopyOwner): void => {
  if (!owns(state, owner)) return;
  const prior = owner.prior;
  const value = retire(state);
  const generation = state.generation;
  const clipboard = state.clipboard;
  if (Option.isNone(clipboard) || Option.isNone(value)) return;
  // Native operations can outlive the scope. Recheck local authority after the read.
  Promise.resolve()
    .then(() => clipboard.value.readText())
    .then((observed) => {
      if (state.generation !== generation || Option.isSome(state.current)) return undefined;
      if (observed === value.value || (Option.isSome(prior) && observed === prior.value)) {
        return write(state, "", Option.none());
      }
      return undefined;
    })
    .catch(() => undefined);
};

const cleanPrior = (state: ClipboardState, owner: CopyOwner): Promise<void> => {
  const prior = owner.prior;
  const clipboard = state.clipboard;
  if (Option.isNone(prior) || Option.isNone(clipboard)) return Promise.resolve();
  return Promise.resolve()
    .then(() => clipboard.value.readText())
    .then((observed) => {
      if (owns(state, owner) && observed === prior.value) {
        return write(state, "", Option.some(owner));
      }
      return undefined;
    })
    .catch(() => undefined)
    .finally(() => {
      owner.prior = Option.none();
    });
};

const writeCopy = (state: ClipboardState, value: string, owner: CopyOwner): Promise<void> =>
  cleanPrior(state, owner).then(() =>
    owns(state, owner) ? write(state, value, Option.some(owner)) : undefined
  );

const priorValue = (state: ClipboardState): Option.Option<string> => {
  if (Option.isNone(state.current)) return Option.none();
  const owner = state.current.value;
  return owner.written ? owner.value : owner.prior;
};

const copy =
  (state: ClipboardState, run: Run, lifetime: Duration.Input): SensitiveClipboard["copy"] =>
  (value, onCopied) => {
    if (!state.open) return { release: () => undefined };
    const prior = priorValue(state);
    retire(state);
    state.generation += 1;
    const owner: CopyOwner = { value: Option.some(value), prior, written: false };
    state.current = Option.some(owner);
    run(
      Effect.tryPromise({
        try: () => writeCopy(state, value, owner),
        catch: () => new ClipboardAccessFailed(),
      }).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.sync(() => release(state, owner)),
          onSuccess: () => {
            if (!owns(state, owner)) return Effect.void;
            owner.written = true;
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
