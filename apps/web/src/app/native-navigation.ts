import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import type { Url } from "foldkit/url";
import { Message } from "./native-model";

const nextPaint: Effect.Effect<void> = Effect.callback((resume) => {
  const frame = requestAnimationFrame(() => queueMicrotask(() => resume(Effect.void)));
  return Effect.sync(() => cancelAnimationFrame(frame));
});
const Scroll = Command.define("RestoreApplicationScroll", {
  args: { pathname: Schema.String, hash: Schema.Option(Schema.String), reset: Schema.Boolean },
  messages: [Message.Completed],
  execute: ({ pathname, hash, reset }) =>
    Effect.gen(function* () {
      // The page and its embedded feature each render on the animation frame queue.
      yield* nextPaint;
      yield* nextPaint;
      yield* nextPaint;
      if (
        location.pathname !== pathname ||
        location.hash !==
          Option.match(hash, {
            onNone: () => "",
            onSome: (fragment) => `#${fragment}`,
          })
      ) {
        return Message.Completed();
      }
      if (Option.isSome(hash)) {
        document.getElementById(hash.value)?.scrollIntoView();
      } else if (reset) {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }
      return Message.Completed();
    }),
});
/** Restores anchors after the embedded page mounts, dropping work from superseded navigation. */
export const restoreScroll = ({
  url,
  reset,
}: Readonly<{ url: Url; reset: boolean }>): Command.Command<Message> =>
  Scroll({ pathname: url.pathname, hash: url.hash, reset });
