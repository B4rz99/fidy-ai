/** Retargets a single underline; layout coordinates also support wrapped mobile tabs. */
export const moveIndicator = ({
  tab,
  instant,
}: {
  tab: HTMLButtonElement;
  instant: boolean;
}): void => {
  const list = tab.parentElement;
  const indicator = list?.querySelector<HTMLElement>(".feature-indicator");
  if (list === null || indicator == null) return;
  list.dataset.instant = String(instant);
  indicator.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop + tab.offsetHeight - 3}px) scaleX(${tab.offsetWidth})`;
};

/** Repositions immediately after resizing and releases the observer on unmount. */
export const mountIndicator = (list: HTMLDivElement): (() => void) => {
  const position = (): void => {
    const active = list.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (active !== null) moveIndicator({ tab: active, instant: true });
  };
  const focus = (event: FocusEvent): void => {
    if (event.target instanceof HTMLButtonElement) {
      moveIndicator({ tab: event.target, instant: true });
    }
  };
  position();
  list.addEventListener("focusin", focus);
  if (typeof ResizeObserver === "undefined") {
    return (): void => list.removeEventListener("focusin", focus);
  }
  const observer = new ResizeObserver(position);
  observer.observe(list);
  list.querySelectorAll("button").forEach((tab) => observer.observe(tab));
  return (): void => {
    list.removeEventListener("focusin", focus);
    observer.disconnect();
  };
};
