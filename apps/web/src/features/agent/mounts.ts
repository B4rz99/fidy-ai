import { Effect, Queue, Schema } from "effect";
import { Mount } from "foldkit";
import type { ConversationController } from "./controller";
import { observeConversationEnd } from "@/browser/stick-to-end";
import { Message } from "./model";

export type Mounts = Readonly<{
  scroll: () => Mount.MountAction<Message>;
  scrollButton: () => Mount.MountAction<Message>;
  input: () => Mount.MountAction<Message>;
  visible: (args: Readonly<{ active: boolean }>) => Mount.MountAction<Message>;
  dialog: () => Mount.MountAction<Message>;
}>;
const composer = (
  input: HTMLTextAreaElement,
  controller: ConversationController,
  events: Queue.Queue<Message>
): (() => void) => {
  const release = controller.mountInput(input);
  const edit = (): void => {
    controller.edit(input.value);
    Queue.offerUnsafe(events, Message.ChangedDraft({ present: input.value.trim().length > 0 }));
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      input.form?.requestSubmit();
    }
  };
  input.addEventListener("input", edit);
  input.addEventListener("keydown", key);
  input.focus();
  return () => {
    release();
    input.removeEventListener("input", edit);
    input.removeEventListener("keydown", key);
  };
};
const dialog = (element: Element, events: Queue.Queue<Message>): (() => void) => {
  const close = (): void => {
    Queue.offerUnsafe(events, Message.ChangedOpen({ open: false }));
    document.getElementById("hosted-launcher")?.focus();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  const outside = (event: PointerEvent): void => {
    if (
      event.target instanceof Node &&
      !element.contains(event.target) &&
      document.getElementById("hosted-launcher")?.contains(event.target) !== true
    ) {
      close();
    }
  };
  document.addEventListener("keydown", key);
  document.addEventListener("pointerdown", outside);
  return () => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("pointerdown", outside);
    document.getElementById("hosted-launcher")?.focus();
  };
};
const scrollButton: Mounts["scrollButton"] = Mount.define("ScrollHostedConversation", {
  messages: [Message.CompletedMount],
  execute: ({ element }) => {
    const scroll = (): void => {
      const conversation = element
        .closest('[role="dialog"]')
        ?.querySelector<HTMLElement>('[aria-label="Conversación con Fidy"]');
      if (conversation !== null && conversation !== undefined) {
        conversation.scrollTop = conversation.scrollHeight;
      }
    };
    return Effect.acquireRelease(
      Effect.sync(() => element.addEventListener("click", scroll)),
      () => Effect.sync(() => element.removeEventListener("click", scroll))
    ).pipe(Effect.as(Message.CompletedMount()));
  },
});

/** Browser ownership covers composition keys, dismissal and committed document visibility. */
export const makeConversationMounts = ({
  controller,
  events,
}: Readonly<{ controller: ConversationController; events: Queue.Queue<Message> }>): Mounts => ({
  scroll: Mount.define("FollowHostedConversation", {
    messages: [Message.CompletedMount],
    execute: ({ element }) => {
      if (!(element instanceof HTMLElement)) return Effect.succeed(Message.CompletedMount());
      return Effect.acquireRelease(
        Effect.sync(() => observeConversationEnd(element)),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.CompletedMount()));
    },
  }),
  scrollButton,
  input: Mount.define("MountHostedComposer", {
    messages: [Message.CompletedMount],
    execute: ({ element }) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        return Effect.succeed(Message.CompletedMount());
      }
      return Effect.acquireRelease(
        Effect.sync(() => composer(element, controller, events)),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.CompletedMount()));
    },
  }),
  visible: Mount.define("ObserveVisibleHostedReply", {
    args: { active: Schema.Boolean },
    messages: [Message.CompletedMount],
    execute: ({ active }) => {
      if (!active) return Effect.succeed(Message.CompletedMount());
      const acknowledge = (): void => {
        if (document.visibilityState === "visible") {
          Queue.offerUnsafe(events, Message.RequestedWork({ action: "Visible" }));
        }
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          document.addEventListener("visibilitychange", acknowledge);
          acknowledge();
        }),
        () => Effect.sync(() => document.removeEventListener("visibilitychange", acknowledge))
      ).pipe(Effect.as(Message.CompletedMount()));
    },
  }),
  dialog: Mount.define("MountHostedDialog", {
    messages: [Message.CompletedMount],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => dialog(element, events)),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.CompletedMount())),
  }),
});
