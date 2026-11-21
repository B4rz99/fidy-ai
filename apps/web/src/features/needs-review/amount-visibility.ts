import { Option } from "effect";
import { type RefCallback, useCallback } from "react";

type AmountMeasurement = Readonly<{ top: number; bottom: number; height: number }>;

const clearance = 8;

export const useReviewAmountVisibility = (
  error: Option.Option<string>
): RefCallback<HTMLDivElement> => {
  const message = Option.getOrElse(error, () => "");

  return useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      if (node === null || message === "") return;

      return observeAmount(node);
    },
    [message]
  );
};

const observeAmount = (node: HTMLDivElement): ReturnType<RefCallback<HTMLDivElement>> => {
  const form = node.closest<HTMLElement>('[data-review="form"]');
  const columns = node.closest<HTMLElement>('[data-review="columns"]');

  if (form === null || columns === null) return;
  const footer = columns.parentElement?.querySelector<HTMLElement>('[data-review="footer"]');

  if (footer === undefined || footer === null) return;
  const amount = node.querySelector<HTMLElement>('[data-review="amount"]');
  const help = node.querySelector<HTMLElement>('[data-review="amount-help"]');

  if (amount === null || help === null) return;

  const measure = (): AmountMeasurement => {
    const top = amount.getBoundingClientRect().top;
    const bottom = help.getBoundingClientRect().bottom;

    return { top, bottom, height: bottom - top };
  };

  const reveal = (): void => {
    const viewport = getComputedStyle(form).overflowY === "auto" ? form : columns;

    if (getComputedStyle(viewport).overflowY !== "auto") return;
    const bounds = viewport.getBoundingClientRect();

    if (bounds.height === 0) return;
    revealPage(bounds, footer, measure().height);
    const visible = viewport.getBoundingClientRect();
    const top = Math.max(visible.top, 0) + clearance;

    const end =
      Math.min(visible.bottom, footer.getBoundingClientRect().top, window.innerHeight) - clearance;

    const target = measure();

    if (target.bottom > end) {
      viewport.scrollBy({ top: target.bottom - end, behavior: "instant" });
    } else if (target.height <= end - top && target.top < top) {
      viewport.scrollBy({ top: target.top - top, behavior: "instant" });
    }
  };

  const observer = new ResizeObserver(reveal);
  [amount, help, form, columns].forEach((element) => observer.observe(element));
  reveal();

  return (): void => observer.disconnect();
};

const revealPage = (bounds: DOMRect, footer: HTMLElement, fieldHeight: number): void => {
  const bottom = Math.min(bounds.bottom, footer.getBoundingClientRect().top, window.innerHeight);
  const available = bottom - Math.max(bounds.top, 0);

  if (fieldHeight + clearance * 2 > available && bounds.top > clearance) {
    window.scrollBy({
      top: Math.min(fieldHeight + clearance * 2 - available, bounds.top - clearance),
      behavior: "instant",
    });
  }
};
