import { type ReactNode, createContext, useContext, useState, useSyncExternalStore } from "react";
import { mountMotion } from "./motion";

const storageKey = "fidy-landing-theme";
const themes = ["light", "dark", "system"] as const;
type Theme = (typeof themes)[number];
const ThemeContext = createContext({ dark: false, toggle: (): void => {} });
const systemDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;
const subscribe = (notify: () => void): (() => void) => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

export const ThemeToggle = (): React.JSX.Element => {
  const { dark, toggle } = useContext(ThemeContext);
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={dark ? "Activar tema claro" : "Activar tema oscuro"}
      title={dark ? "Activar tema claro" : "Activar tema oscuro"}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {dark ? (
          <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </>
        )}
      </svg>
    </button>
  );
};

const readTheme = (): Theme => {
  try {
    const saved = localStorage.getItem(storageKey);
    return themes.find((theme) => theme === saved) ?? "system";
  } catch {
    return "system";
  }
};

/** Scopes the preview theme to the public site and remembers only a display preference. */
export const LandingTheme = ({
  children,
  detail,
}: {
  children: ReactNode;
  detail: boolean;
}): React.JSX.Element => {
  const [theme, setTheme] = useState(readTheme);
  const prefersDark = useSyncExternalStore(subscribe, systemDark);
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  const select = (next: Theme): void => {
    setTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The theme still works for this visit when browser storage is unavailable.
    }
  };
  return (
    <ThemeContext value={{ dark, toggle: () => select(dark ? "light" : "dark") }}>
      <div
        className={`fidy-landing variant-a${detail ? " feature-detail-open" : ""}`}
        data-theme={theme}
        ref={detail ? undefined : mountMotion}
      >
        {children}
      </div>
    </ThemeContext>
  );
};
