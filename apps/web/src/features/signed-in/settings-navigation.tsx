import { HugeiconsIcon } from "@hugeicons/react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { Link, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { dismissCompactNavigation } from "./dismiss-navigation";

const settingsLinks = [
  { to: "/settings/privacy", label: "Privacidad" },
  { to: "/settings/account", label: "Cuenta" },
  { to: "/settings/access", label: "Accesos" },
] as const;

export const SettingsNavigation = (): JSX.Element => {
  const inSettings = useRouterState({
    select: (state) => state.location.pathname.startsWith("/settings/"),
  });
  return (
    <details className="shrink-0" open={inSettings}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-4 rounded-md px-4 py-3 text-base text-muted-foreground hover:bg-muted">
        <HugeiconsIcon icon={Settings01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
        Ajustes
      </summary>
      <div className="flex flex-col gap-1 py-2 pl-4">
        {settingsLinks.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            search={{}}
            onClick={dismissCompactNavigation}
            className="rounded-md px-4 py-2 text-sm hover:bg-muted"
            activeProps={{ className: "bg-secondary text-secondary-foreground" }}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </details>
  );
};
