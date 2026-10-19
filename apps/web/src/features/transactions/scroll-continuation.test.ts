// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { observeContinuation } from "./scroll-continuation";

afterEach(() => vi.unstubAllGlobals());
const setup = (): Readonly<{
  deliver: (visible: ReadonlyArray<boolean>) => void;
  onMore: ReturnType<typeof vi.fn>;
  dispose: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}> => {
  const element = document.createElement("div");
  const onMore = vi.fn();
  const disconnect = vi.fn();
  let deliver = (_visible: ReadonlyArray<boolean>): void => undefined;
  class Observer implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px 0px 160px 0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) {
      deliver = (visible): void => {
        const rectangle = element.getBoundingClientRect();
        callback(
          visible.map((isIntersecting) => ({
            target: element,
            time: 0,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            boundingClientRect: rectangle,
            intersectionRect: rectangle,
            rootBounds: null,
          })),
          this
        );
      };
    }
    disconnect = disconnect;
    observe(target: Element): void {
      expect(target).toBe(element);
    }
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const dispose = observeContinuation({ element, onMore });
  return { deliver: (visible) => deliver(visible), onMore, dispose, disconnect };
};

it("loads once when the end becomes visible and ignores other observations", () => {
  const fixture = setup();
  fixture.deliver([]);
  fixture.deliver([false]);
  expect(fixture.onMore).not.toHaveBeenCalled();
  fixture.deliver([false, true]);
  fixture.deliver([true]);
  expect(fixture.onMore).toHaveBeenCalledOnce();
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  fixture.dispose();
});

it("drops queued observations after route or state teardown", () => {
  const fixture = setup();
  fixture.dispose();
  fixture.deliver([true]);
  expect(fixture.onMore).not.toHaveBeenCalled();
  expect(fixture.disconnect).toHaveBeenCalledOnce();
});
