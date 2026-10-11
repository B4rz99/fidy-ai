import { Effect, Option, Queue, Redacted } from "effect";
import { Mount } from "foldkit";
import { makeMountedClipboard } from "@/browser/mounted-clipboard";
import { sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import type { TokenBearer } from "@/transport/client";
import { ManualMessage as Message } from "./manual-model";

type Disclosure = Readonly<{
  retain: (value: Redacted.Redacted<TokenBearer>) => boolean;
  clear: () => void;
  dispose: () => void;
  reveal: () => Mount.MountAction<Message>;
  copy: () => Mount.MountAction<Message>;
}>;
/** A bearer can reach only its mounted disclosure and native clipboard gesture. */
export const makeManualDisclosure = (events: Queue.Queue<Message>): Disclosure => {
  const owned = makeMountedClipboard(sensitiveClipboardLifetime);
  let bearer = Option.none<Redacted.Redacted<TokenBearer>>();
  let active = true;
  const elements = new Set<Element>();
  const clear = (): void => {
    if (Option.isSome(bearer)) owned.clipboard.clear(Redacted.value(bearer.value));
    bearer = Option.none();
    for (const element of elements) element.textContent = "";
  };
  const expire = (): void => {
    clear();
    if (active) Queue.offerUnsafe(events, Message.Reset());
  };
  window.addEventListener("pagehide", expire);
  const copy = (): void => {
    if (active && Option.isSome(bearer)) {
      owned.clipboard.copy(Redacted.value(bearer.value), () => {
        if (active) Queue.offerUnsafe(events, Message.Copied());
      });
    }
  };
  return {
    retain: (value) => {
      if (!active) return false;
      clear();
      bearer = Option.some(value);
      owned.clipboard.reveal(expire);
      return true;
    },
    clear,
    dispose: () => {
      active = false;
      clear();
      elements.clear();
      window.removeEventListener("pagehide", expire);
      owned.dispose();
    },
    ...makeMounts({
      reveal: (element) => {
        if (active && Option.isSome(bearer)) {
          elements.add(element);
          element.textContent = Redacted.value(bearer.value);
        }
      },
      conceal: (element) => {
        elements.delete(element);
        element.textContent = "";
      },
      copy,
    }),
  };
};

const makeMounts = (
  actions: Readonly<{
    reveal: (element: Element) => void;
    conceal: (element: Element) => void;
    copy: () => void;
  }>
): Pick<Disclosure, "reveal" | "copy"> => ({
  reveal: Mount.define("RevealManualPAT", {
    messages: [Message.Mounted],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => actions.reveal(element)),
        () => Effect.sync(() => actions.conceal(element))
      ).pipe(Effect.as(Message.Mounted())),
  }),
  copy: Mount.define("CopyManualPAT", {
    messages: [Message.Mounted],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => element.addEventListener("click", actions.copy)),
        () => Effect.sync(() => element.removeEventListener("click", actions.copy))
      ).pipe(Effect.as(Message.Mounted())),
  }),
});
