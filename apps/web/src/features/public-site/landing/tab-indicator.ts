/** Retargets a single underline; layout coordinates also support wrapped mobile tabs. */
export const moveIndicator = (tab: HTMLButtonElement, instant: boolean): void => {
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
    if (active !== null) moveIndicator(active, true);
  };
  position();
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(position);
  observer.observe(list);
  list.querySelectorAll("button").forEach((tab) => observer.observe(tab));
  return (): void => observer.disconnect();
};
