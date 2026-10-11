const endTolerance = 8;

/** Follows new messages while the reader stays at the end, without pulling them from older text. */
export const observeConversationEnd = (element: HTMLElement): (() => void) => {
  let follow = true;
  let frame = 0;
  const scroll = (): void => {
    follow = element.scrollHeight - element.clientHeight - element.scrollTop <= endTolerance;
  };
  const update = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (follow) element.scrollTop = element.scrollHeight;
    });
  };
  const observer = new MutationObserver(update);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  element.addEventListener("scroll", scroll);
  update();
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", scroll);
    cancelAnimationFrame(frame);
  };
};
