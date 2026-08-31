import { Data, Effect, Function, Option } from "effect";

/** The browser clipboard is absent or refused an attempted read or write. */
export class ClipboardAccessFailed extends Data.TaggedError("ClipboardAccessFailed")<{}> {}

type ClipboardReader = Readonly<{ readText: () => Promise<string> }>;
type ClipboardWriter = Readonly<{ writeText: (text: string) => Promise<void> }>;

/** Reads clipboard text when the browser exposes and authorizes that capability. */
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

/** Writes clipboard text when the browser exposes and authorizes that capability. */
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
