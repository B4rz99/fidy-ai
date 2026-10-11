import "@testing-library/jest-dom/vitest";

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  readonly matches = false;
  readonly media: string;
  onchange: MediaQueryList["onchange"] = null;
  constructor(media: string) {
    super();
    this.media = media;
  }
  addListener(): void {}
  removeListener(): void {}
}

globalThis.matchMedia = (media): MediaQueryList => new TestMediaQueryList(media);

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): Array<IntersectionObserverEntry> {
    return [];
  }
}
globalThis.IntersectionObserver = TestIntersectionObserver;
if (typeof Element !== "undefined") {
  Object.defineProperties(Element.prototype, {
    animate: {
      configurable: true,
      value: (): Pick<Animation, "cancel"> => ({ cancel: (): void => undefined }),
    },
    getAnimations: { configurable: true, value: (): Array<Animation> => [] },
  });
}

// JSDOM does not implement the browser's native popover methods.
if (typeof HTMLElement !== "undefined") {
  Object.defineProperties(HTMLElement.prototype, {
    hidePopover: { configurable: true, value: (): void => undefined },
    showPopover: { configurable: true, value: (): void => undefined },
  });
}

if (typeof window !== "undefined") {
  window.scrollTo = (): void => undefined;
  Element.prototype.scrollIntoView = (): void => undefined;
}
