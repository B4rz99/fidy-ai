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
import { type JSX, type ReactNode, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { presentCanonicalQuery } from "@/transport/canonical-query";
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

/** Share the Transactions page's fresh Consent query before mounting ordinary navigation reads. */
const ConsentedReviewCount = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  return state._tag === "Ready" &&
    !state.waiting &&
    Option.isNone(state.refreshFailure) &&
    state.value.status === "Granted" ? (
    <>{children}</>
  ) : (
    <></>
  );
};

export const SignedInNavigation = ({
  onLogout,
  loggingOut,
  reviewPendingCount,
}: Readonly<{
  onLogout: () => void;
  loggingOut: boolean;
  reviewPendingCount: ReactNode;
}>): JSX.Element => {
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  const transactions = useRouterState({
    select: (state) => state.location.pathname === "/app/transactions",
  });
  const { initialSessionBinding } = useRouter().options.context;
  const signedIn = authentication !== "expired" && initialSessionBinding !== "none";
  const count = transactions ? (
    <ConsentedReviewCount>{reviewPendingCount}</ConsentedReviewCount>
  ) : (
    reviewPendingCount
  );
  return (
    <nav aria-label="Aplicación" className="application-navigation">
      {navigationLinks.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          search={{}}
          onClick={dismissCompactNavigation}
          className="application-navigation-link"
          activeProps={{ className: "application-navigation-active" }}
        >
          <HugeiconsIcon icon={link.icon} size={22} strokeWidth={1.5} aria-hidden="true" />
          {link.label}
          {link.to === "/app/needs-review" && signedIn && !privacy ? count : null}
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
