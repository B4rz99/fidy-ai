import type { MouseEvent } from "react";

export const dismissCompactNavigation = (event: MouseEvent<HTMLAnchorElement>): void => {
  event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
};
