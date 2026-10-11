const trapTab = (element: HTMLElement, event: KeyboardEvent): void => {
  const controls = Array.from(
    element.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]"
    )
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};
const makeBackgroundInert = (element: HTMLElement): (() => void) => {
  const siblings: Readonly<{ element: HTMLElement; inert: boolean }>[] = [];
  let ancestor: HTMLElement = element;
  while (ancestor.parentElement !== null) {
    for (const sibling of ancestor.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== ancestor) {
        siblings.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
    }
    ancestor = ancestor.parentElement;
  }
  return (): void => {
    for (const sibling of siblings) sibling.element.inert = sibling.inert;
  };
};
/** Keeps one mounted form while switching between a desktop rail and a mobile modal. */
export const bindResponsivePanel = (element: HTMLElement): (() => void) => {
  const media = window.matchMedia("(min-width: 1280px)");
  const previousFocus = document.activeElement;
  let restore: () => void = (): void => {};
  const synchronize = (): void => {
    restore();
    if (media.matches) {
      element.removeAttribute("role");
      element.removeAttribute("aria-modal");
      return;
    }
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "true");
    element.setAttribute("aria-labelledby", "transaction-panel-title");
    restore = makeBackgroundInert(element);
    element.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (media.matches) return;
    if (event.key === "Escape") {
      event.preventDefault();
      element.querySelector<HTMLButtonElement>("header button")?.click();
    }
    if (event.key !== "Tab") return;
    trapTab(element, event);
  };
  synchronize();
  element.addEventListener("keydown", keydown);
  media.addEventListener("change", synchronize);
  return (): void => {
    restore();
    element.removeEventListener("keydown", keydown);
    media.removeEventListener("change", synchronize);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
};
