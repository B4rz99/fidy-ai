import { Schema } from "effect";
import { type RefCallback, useCallback, useSyncExternalStore } from "react";

const Theme = Schema.Literals(["light", "dark"]);
const preferenceKey = "fidy-theme-v1";
const preferenceChanged = "fidy-theme-changed";
const readPreference = (): "light" | "dark" => {
  try {
    const stored = Schema.decodeUnknownOption(Theme)(localStorage.getItem(preferenceKey));
    if (stored._tag === "Some") return stored.value;
  } catch {
    // Browser storage can be unavailable; the system preference remains usable.
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
const subscribe = (changed: () => void): (() => void) => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", changed);
  window.addEventListener("storage", changed);
  window.addEventListener(preferenceChanged, changed);
  return () => {
    media.removeEventListener("change", changed);
    window.removeEventListener("storage", changed);
    window.removeEventListener(preferenceChanged, changed);
  };
};
export const useTheme = (): Readonly<{
  theme: "light" | "dark";
  mounted: RefCallback<HTMLDivElement>;
  toggle: () => void;
}> => {
  const theme = useSyncExternalStore(subscribe, readPreference);
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
    toggle: () => {
      try {
        localStorage.setItem(preferenceKey, theme === "dark" ? "light" : "dark");
      } catch {
        return;
      }
      window.dispatchEvent(new Event(preferenceChanged));
    },
  };
};
