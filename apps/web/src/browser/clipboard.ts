import { Data, Effect, Function, Option } from "effect";

export class ClipboardAccessFailed extends Data.TaggedError("ClipboardAccessFailed")<{}> {}

/** Read capability modeled separately because browsers may deny it while allowing writes. */
export type ClipboardReader = Readonly<{ readText: () => Promise<string> }>;

/** Write capability whose rejected Promise represents browser or permission failure. */
export type ClipboardWriter = Readonly<{ writeText: (text: string) => Promise<void> }>;

export type BrowserClipboard = ClipboardReader & ClipboardWriter;

export const readClipboardText = (
  clipboard: Option.Option<ClipboardReader>
): Effect.Effect<string, ClipboardAccessFailed> =>
  Option.match(clipboard, {
    onNone: () => Effect.fail(new ClipboardAccessFailed()),
    onSome: (available) =>
      Effect.tryPromise({
        try: () => available.readText(),
        catch: () => new ClipboardAccessFailed(),
      }),
  });

export const writeClipboardText: {
  (
    text: string
  ): (clipboard: Option.Option<ClipboardWriter>) => Effect.Effect<void, ClipboardAccessFailed>;
  (
    clipboard: Option.Option<ClipboardWriter>,
    text: string
  ): Effect.Effect<void, ClipboardAccessFailed>;
} = Function.dual(2, (clipboard: Option.Option<ClipboardWriter>, text: string) =>
  Option.match(clipboard, {
    onNone: () => Effect.fail(new ClipboardAccessFailed()),
    onSome: (available) =>
      Effect.tryPromise({
        try: () => available.writeText(text),
        catch: () => new ClipboardAccessFailed(),
      }),
  })
);
