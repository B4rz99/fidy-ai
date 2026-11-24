import { type Cause, Effect } from "effect";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatWindow } from "@/ui/components/chat";

const reactWork = (work: () => void): Promise<void> => Promise.resolve(act(work));

const compactQuery = "(max-height: 500px), (max-width: 600px)";

const flushReact = (work: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => reactWork(work));

const awaitPosition = (
  positioner: HTMLElement,
  position: string
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => vi.waitFor(() => expect(positioner.style.position).toBe(position)));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("an open window switches to viewport-fixed positioning when the window narrows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const viewport = { width: 1280, height: 800 };
      const mediaListeners = new Set<(event: Event) => void>();

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        }
      );
      vi.stubGlobal("matchMedia", (query: string) => ({
        media: query,
        get matches(): boolean {
          if (query !== compactQuery) return false;

          return viewport.width <= 600 || viewport.height <= 500;
        },
        onchange: null,
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
        addEventListener: (_type: string, listener: (event: Event) => void): void => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: Event) => void): void => {
          mediaListeners.delete(listener);
        },
        dispatchEvent: (): boolean => false,
      }));

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);

      yield* flushReact(() =>
        root.render(
          createElement(ChatWindow, {
            open: true,
            onOpenChange: (): void => undefined,
            prepare: (): void => undefined,
            children: createElement("p", null, "borrador conservado"),
          })
        )
      );

      const popup = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
      const positioner = popup === null ? null : popup.parentElement;

      if (popup === null || positioner === null) throw new Error("popover did not mount");

      yield* awaitPosition(positioner, "absolute");

      const resize = (width: number, height: number): Effect.Effect<void, Cause.UnknownError> =>
        Effect.gen(function* () {
          viewport.width = width;
          viewport.height = height;
          yield* flushReact(() => {
            for (const listener of mediaListeners) listener(new Event("change"));
          });
        });

      yield* resize(390, 844);
      yield* awaitPosition(positioner, "fixed");
      expect(popup.textContent).toContain("borrador conservado");

      yield* resize(1280, 800);
      yield* awaitPosition(positioner, "absolute");

      yield* flushReact(() => root.unmount());
      container.remove();
    })
  ));
