import {
  observeThemePreference,
  readThemePreference,
  toggleThemePreference,
} from "@/browser/theme-preference";
import { type RefCallback, useCallback, useSyncExternalStore } from "react";

export const useTheme = (): Readonly<{
  theme: "light" | "dark";
  mounted: RefCallback<HTMLDivElement>;
  toggle: () => void;
}> => {
  const theme = useSyncExternalStore(observeThemePreference, readThemePreference);
  const mounted = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      if (element === null) return;
      const root = element.ownerDocument.documentElement;
      const previous = root.classList.contains("dark");
      root.classList.toggle("dark", theme === "dark");
      return (): void => {
        root.classList.toggle("dark", previous);
      };
    },
    [theme]
  );
  return {
    theme,
    mounted,
    toggle: () => toggleThemePreference(theme),
  };
};
