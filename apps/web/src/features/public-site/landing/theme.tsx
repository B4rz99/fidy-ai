import { type ReactNode, useState } from "react";
import { mountMotion } from "./motion";

const storageKey = "fidy-landing-theme";
const themes = ["light", "dark", "system"] as const;
type Theme = (typeof themes)[number];
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
  const select = (next: Theme): void => {
    setTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The theme still works for this visit when browser storage is unavailable.
    }
  };
  return (
    <div
      className={`fidy-landing variant-a${detail ? " feature-detail-open" : ""}`}
      data-theme={theme}
      ref={detail ? undefined : mountMotion}
    >
      {children}
      <fieldset className="theme-picker" aria-label="Apariencia">
        {themes.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={theme === choice}
            onClick={() => select(choice)}
          >
            {
              {
                light: "Claro",
                dark: "Oscuro",
                system: "Sistema",
              }[choice]
            }
          </button>
        ))}
      </fieldset>
    </div>
  );
};
