import type { RefCallback } from "react";

export const focusCreation: RefCallback<HTMLElement> = (element): void => {
  element?.focus();
  element?.closest('[role="dialog"]')?.scrollIntoView({ block: "start" });
};
