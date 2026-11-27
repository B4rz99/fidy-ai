import type { MouseEvent } from "react";

export const dismissCompactNavigation = (event: MouseEvent<HTMLAnchorElement>): void => {
  event.currentTarget.closest<HTMLDialogElement>("dialog#signed-in-navigation")?.close();
};
