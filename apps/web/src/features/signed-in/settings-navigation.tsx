import { HugeiconsIcon } from "@hugeicons/react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { Link, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { dismissCompactNavigation } from "./dismiss-navigation";

const settingsLinks = [
  { to: "/settings/account", label: "Cuenta" },
  { to: "/settings/privacy", label: "Privacidad" },
  { to: "/settings/access", label: "Accesos" },
] as const;

export const SettingsNavigation = (): JSX.Element => {
  const inSettings = useRouterState({
    select: (state) => state.location.pathname.startsWith("/settings/"),
  });
  return (
    <details className="shrink-0" open={inSettings}>
      <summary
        className={
          inSettings
            ? "application-navigation-link application-navigation-active"
            : "application-navigation-link"
        }
      >
        <HugeiconsIcon icon={Settings01Icon} size={22} strokeWidth={1.5} aria-hidden="true" />
        Ajustes
      </summary>
      <div className="application-settings-links">
        {settingsLinks.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            search={{}}
            onClick={dismissCompactNavigation}
            className="application-settings-link"
            activeProps={{ className: "application-navigation-active" }}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </details>
  );
};
