import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentProps, type JSX, type ReactNode } from "react";
import { fidyLogoUrl } from "@/ui/brand";
import { Button } from "./button";
import { useTheme } from "./theme";
import "./application.css";

const mascot = new URL("../assets/access/mascot.png", import.meta.url).href;
const habitat = new URL("../assets/access/habitat-ceiba.png", import.meta.url).href;

export const ApplicationSurface = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => {
  const { theme, toggle, mounted } = useTheme();
  return (
    <div ref={mounted} className="signed-in-theme application-shell">
      <svg width="0" height="0" aria-hidden="true" className="application-logo-filter">
        <defs>
          <filter id="application-logo-knockout" colorInterpolationFilters="sRGB">
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 3 3 3 0 0"
              result="visible-logo"
            />
            <feComposite in="SourceGraphic" in2="visible-logo" operator="in" />
          </filter>
        </defs>
      </svg>
      {children}
      <div className="application-theme-control">
        <Button
          className="application-theme-button"
          variant="outline"
          size="icon"
          onClick={toggle}
          aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
        >
          <HugeiconsIcon
            icon={theme === "dark" ? Sun03Icon : Moon02Icon}
            size={22}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
};

export const ApplicationWordmark = (): JSX.Element => (
  <img className="application-logo" src={fidyLogoUrl} alt="Fidy" />
);
export const ApplicationHabitat = (): JSX.Element => (
  <div className="application-habitat" aria-hidden="true">
    <img className="application-habitat-plants" src={habitat} alt="" />
    <img className="application-habitat-mascot" src={mascot} alt="" />
  </div>
);

export const ApplicationLogoutAction = (props: ComponentProps<typeof Button>): JSX.Element => (
  <Button {...props} className="application-logout" variant="ghost" />
);
export const ApplicationMenuAction = (props: ComponentProps<typeof Button>): JSX.Element => (
  <Button {...props} className="application-theme-button" variant="outline" size="icon" />
);
