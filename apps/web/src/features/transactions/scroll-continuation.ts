/** Observes the visible end once; disposing prevents queued observations from requesting more. */
export const observeContinuation = ({
  element,
  onMore,
}: Readonly<{ element: HTMLElement; onMore: () => void }>): (() => void) => {
  let requested = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || requested) return;
      requested = true;
      observer.disconnect();
      onMore();
    },
    { rootMargin: "0px 0px 160px 0px" }
  );
  observer.observe(element);
  return (): void => {
    requested = true;
    observer.disconnect();
  };
};
