import { Option, Schema } from "effect";

const Theme = Schema.Literals(["light", "dark"]);

const preferenceKey = "fidy-theme-v1";

const preferenceChanged = "fidy-theme-changed";

export const readThemePreference = (): "light" | "dark" => {
  try {
    const stored = Schema.decodeUnknownOption(Theme)(localStorage.getItem(preferenceKey));

    if (Option.isSome(stored)) return stored.value;
  } catch {}

  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const observeThemePreference = (changed: () => void): (() => void) => {
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

export const toggleThemePreference = (theme: "light" | "dark"): void => {
  try {
    localStorage.setItem(preferenceKey, theme === "dark" ? "light" : "dark");
  } catch {
    return;
  }

  window.dispatchEvent(new Event(preferenceChanged));
};
