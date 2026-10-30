import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  CreditCardIcon,
  CrownIcon,
  Home01Icon,
  Logout02Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { type JSX, type ReactNode } from "react";
import { useSession } from "@/session/session-context";
import {
  ApplicationHabitat,
  ApplicationLogoutAction,
  ApplicationWordmark,
} from "@/ui/components/application";
import { SettingsNavigation } from "./settings-navigation";
import { dismissCompactNavigation } from "./dismiss-navigation";

const navigationLinks = [
  { to: "/app/dashboard", label: "Tablero", icon: Home01Icon },
  { to: "/app/transactions", label: "Transacciones", icon: CreditCardIcon },
  { to: "/app/needs-review", label: "Por revisar", icon: CreditCardIcon },
  { to: "/app/budgets", label: "Presupuestos", icon: Wallet01Icon },
  { to: "/app/recurring", label: "Recurrentes", icon: Calendar03Icon },
] as const;

export const SignedInNavigation = ({
  onLogout,
  loggingOut,
  reviewPendingCount,
  prepareNavigation,
}: Readonly<{
  onLogout: () => void;
  loggingOut: boolean;
  reviewPendingCount: ReactNode;
  prepareNavigation: (destination: string) => void;
}>): JSX.Element => {
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  const { sessionBinding } = useRouter().options.context;
  const signedIn = authentication !== "expired" && sessionBinding !== "none";
  return (
    <nav aria-label="Aplicación" className="application-navigation">
      {navigationLinks.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          search={{}}
          onPointerEnter={() => prepareNavigation(link.to)}
          onPointerDownCapture={() => prepareNavigation(link.to)}
          onFocus={() => prepareNavigation(link.to)}
          onClick={dismissCompactNavigation}
          className="application-navigation-link"
          activeProps={{ className: "application-navigation-active" }}
        >
          <HugeiconsIcon icon={link.icon} size={22} strokeWidth={1.5} aria-hidden="true" />
          {link.label}
          {link.to === "/app/needs-review" && signedIn && !privacy ? reviewPendingCount : null}
        </Link>
      ))}
      <SettingsNavigation />
      <Link
        to="/upgrade"
        onClick={dismissCompactNavigation}
        className="application-navigation-link"
        activeProps={{ className: "application-navigation-active" }}
      >
        <HugeiconsIcon icon={CrownIcon} size={22} strokeWidth={1.5} aria-hidden="true" />
        Suscripción
      </Link>
      <NavigationFooter signedIn={signedIn} loggingOut={loggingOut} onLogout={onLogout} />
    </nav>
  );
};

export const SignedInBrand = (): JSX.Element => (
  <Link className="application-brand" to="/app/dashboard">
    <ApplicationWordmark />
  </Link>
);

const NavigationFooter = ({
  signedIn,
  loggingOut,
  onLogout,
}: Readonly<{ signedIn: boolean; loggingOut: boolean; onLogout: () => void }>): JSX.Element => (
  <div className="application-navigation-bottom">
    <ApplicationHabitat />
    {signedIn ? (
      <ApplicationLogoutAction disabled={loggingOut} onClick={onLogout} type="button">
        <HugeiconsIcon icon={Logout02Icon} size={22} strokeWidth={1.5} aria-hidden="true" />
        {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
      </ApplicationLogoutAction>
    ) : (
      <ApplicationLogoutAction nativeButton={false} render={<Link to="/login" reloadDocument />}>
        Iniciar sesión
      </ApplicationLogoutAction>
    )}
  </div>
);
