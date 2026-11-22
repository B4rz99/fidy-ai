import { useSyncExternalStore } from "react";

const desktopQuery = "(min-width: 901px)";

const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches;

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
};

export const useDesktopNavigation = (): boolean => useSyncExternalStore(subscribe, isDesktop);
