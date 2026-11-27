import { Option } from "effect";
import { type Ref, useRef, useState, useSyncExternalStore } from "react";
import type { Item } from "./model";

const mobileQuery = "(max-width: 900px)";

const isMobile = (): boolean => window.matchMedia(mobileQuery).matches;

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
};

type MobileReviewDetailState = Readonly<{
  mobile: boolean;
  open: boolean;
  choose: (item: Item, button: HTMLButtonElement) => void;
  grid: Ref<HTMLDivElement>;
  close: () => void;
  returnFocus: () => Option.Option<HTMLElement>;
}>;

export const useMobileReviewDetail = ({
  available,
  select,
  returnFocusId,
}: Readonly<{
  available: boolean;
  select: (item: Item) => void;
  returnFocusId: string;
}>): MobileReviewDetailState => {
  const mobile = useSyncExternalStore(subscribe, isMobile);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  if (open && (!mobile || !available)) setOpen(false);

  const choose = (item: Item, button: HTMLButtonElement): void => {
    select(item);

    if (mobile) {
      opener.current = button;
      setOpen(true);
    }
  };

  const returnFocus = (): Option.Option<HTMLElement> =>
    Option.orElse(
      Option.filter(Option.fromNullishOr(opener.current), (element) => element.isConnected),
      () =>
        Option.orElse(
          Option.fromNullishOr(grid.current?.querySelector<HTMLElement>('[aria-current="true"]')),
          () => Option.fromNullishOr(document.getElementById(returnFocusId))
        )
    );

  return { mobile, open, choose, grid, close: (): void => setOpen(false), returnFocus };
};
