import { fireEvent } from "@testing-library/dom";
import { Deferred, Effect, Option, Queue, Stream } from "effect";
import type { Mount } from "foldkit";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationController } from "./controller";
import { Message } from "./model";
import { makeConversationMounts } from "./mounts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const setup = (): Readonly<{
  mounts: ReturnType<typeof makeConversationMounts>;
  events: Queue.Queue<Message>;
  edit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}> => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  const edit = vi.fn();
  const release = vi.fn();
  const controller: ConversationController = {
    initial: {
      history: [],
      reply: Option.none(),
      status: "",
      hasDraft: false,
      empty: true,
      canSubmit: true,
      canCheckProgress: false,
      canRetryDelivery: false,
    },
    edit,
    mountInput: () => release,
    run: () => Effect.void,
    dispose: release,
  };
  return { mounts: makeConversationMounts({ controller, events }), events, edit, release };
};
const interact = (
  action: Mount.MountAction<Message>,
  element: Element,
  run: () => void
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const mounted = yield* Deferred.make<void>();
      yield* action.f(element, Stream.empty).pipe(
        Stream.runForEach(() => Deferred.succeed(mounted, undefined)),
        Effect.forkScoped
      );
      yield* Deferred.await(mounted);
      yield* Effect.sync(run);
    })
  );

it("submits Enter while preserving composition, multiline keys, and scoped listener cleanup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mounts, events, edit, release } = setup();
      const form = document.createElement("form");
      const input = document.createElement("textarea");
      form.append(input);
      document.body.append(form);
      const submit = vi.spyOn(form, "requestSubmit").mockImplementation(() => {});
      yield* interact(mounts.input(), input, () => {
        input.value = "  Draft  ";
        fireEvent.input(input);
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
        fireEvent.keyDown(input, { key: "Enter", isComposing: true });
        fireEvent.keyDown(input, { key: "x" });
        expect(submit).toHaveBeenCalledOnce();
        expect(edit).toHaveBeenCalledWith("  Draft  ");
      });
      expect(yield* Queue.take(events)).toEqual(Message.ChangedDraft({ present: true }));
      expect(release).toHaveBeenCalledOnce();
      fireEvent.input(input);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(edit).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
    })
  ));

it("supports a detached composer and refuses to bind a non-textarea input", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mounts, edit, release } = setup();
      yield* interact(mounts.input(), document.createElement("textarea"), () => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
      });
      yield* interact(mounts.input(), document.createElement("input"), () => {});
      expect(release).toHaveBeenCalledOnce();
      expect(edit).not.toHaveBeenCalled();
    })
  ));

it("dismisses outside and Escape events while retaining clicks inside the dialog and launcher", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mounts, events } = setup();
      const launcher = document.createElement("button");
      launcher.id = "hosted-launcher";
      const panel = document.createElement("section");
      document.body.append(launcher, panel);
      yield* interact(mounts.dialog(), panel, () => {
        fireEvent.pointerDown(panel);
        fireEvent.pointerDown(launcher);
        fireEvent.keyDown(document, { key: "x" });
        fireEvent.keyDown(document, { key: "Escape" });
        fireEvent.pointerDown(document.body);
        expect(document.activeElement).toBe(launcher);
      });
      expect(yield* Queue.take(events)).toEqual(Message.ChangedOpen({ open: false }));
      expect(yield* Queue.take(events)).toEqual(Message.ChangedOpen({ open: false }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(Queue.sizeUnsafe(events)).toBe(0);
    })
  ));

it("scrolls only the containing conversation and removes its button listener", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mounts } = setup();
      const panel = document.createElement("section");
      panel.setAttribute("role", "dialog");
      const conversation = document.createElement("div");
      conversation.setAttribute("aria-label", "Conversación con Fidy");
      Object.defineProperty(conversation, "scrollHeight", { value: 300 });
      const button = document.createElement("button");
      panel.append(conversation, button);
      yield* interact(mounts.scrollButton(), button, () => {
        fireEvent.click(button);
        expect(conversation.scrollTop).toBe(300);
      });
      conversation.scrollTop = 0;
      fireEvent.click(button);
      expect(conversation.scrollTop).toBe(0);
      yield* interact(mounts.scrollButton(), document.createElement("button"), () => {});
    })
  ));

it("acknowledges only an active visible document and removes visibility observation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mounts, events } = setup();
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      yield* interact(mounts.visible({ active: false }), document.body, () => {});
      yield* interact(mounts.visible({ active: true }), document.body, () => {
        fireEvent(document, new Event("visibilitychange"));
        visibility.mockReturnValue("visible");
        fireEvent(document, new Event("visibilitychange"));
      });
      expect(yield* Queue.take(events)).toEqual(Message.RequestedWork({ action: "Visible" }));
      fireEvent(document, new Event("visibilitychange"));
      expect(Queue.sizeUnsafe(events)).toBe(0);
      yield* interact(
        mounts.scroll(),
        document.createElementNS("http://www.w3.org/2000/svg", "svg"),
        () => {}
      );
    })
  ));
