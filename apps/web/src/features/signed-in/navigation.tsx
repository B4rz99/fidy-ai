import { transactionEntryConsent } from "@/session/transaction-entry";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  CreditCardIcon,
  CrownIcon,
  Home01Icon,
  Logout02Icon,
  Shield01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { type JSX, type ReactNode, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Option, Predicate } from "effect";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { useSession } from "@/session/session-context";
import {
  ApplicationHabitat,
  ApplicationLogoutAction,
  ApplicationWordmark,
} from "@/ui/components/application";
import { Badge } from "@/ui/components/badge";
import { SettingsNavigation } from "./settings-navigation";
import { dismissCompactNavigation } from "./dismiss-navigation";

const navigationLinks = [
  { to: "/app/dashboard", label: "Tablero", icon: Home01Icon },
  { to: "/app/transactions", label: "Transacciones", icon: CreditCardIcon },
  { to: "/app/needs-review", label: "Por revisar", icon: CreditCardIcon },
  { to: "/app/budgets", label: "Presupuestos", icon: Wallet01Icon },
  { to: "/app/recurring", label: "Recurrentes", icon: Calendar03Icon },
] as const;

const ConsentedReviewCount = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() => transactionEntryConsent(client));
  const state = useAtomValue(query).pipe(presentCanonicalQuery);

  return Predicate.isTagged(state, "Ready") &&
    !state.waiting &&
    Option.isNone(state.refreshFailure) &&
    state.value.status === "Granted" ? (
    <>{children}</>
  ) : (
    <></>
  );
};

export const SignedInNavigation = ({
  readOnly,
  onLogout,
  loggingOut,
  reviewPendingCount,
  prepareNavigation,
}: Readonly<{
  readOnly: boolean;
  onLogout: () => void;
  loggingOut: boolean;
  reviewPendingCount: ReactNode;
  prepareNavigation: (destination: string) => void;
}>): JSX.Element => {
  const { authentication } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const privacy = pathname === "/settings/privacy";
  const transactions = pathname === "/app/transactions";
  const { sessionBinding } = useRouter().options.context;
  const signedIn = authentication !== "expired" && sessionBinding !== "none";

  const count = transactions ? (
    <ConsentedReviewCount>{reviewPendingCount}</ConsentedReviewCount>
  ) : (
    reviewPendingCount
  );

  return (
    <nav aria-label="Aplicación" className="application-navigation">
      {readOnly ? <ReadOnlyNotice /> : null}
      {navigationLinks.flatMap((link) =>
        readOnly && link.to !== "/app/transactions"
          ? []
          : [
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
                {link.to === "/app/needs-review" && signedIn && !privacy ? count : null}
              </Link>,
            ]
      )}
      {readOnly ? <PrivacyLink /> : <ProductNavigation prepareNavigation={prepareNavigation} />}
      <NavigationFooter signedIn={signedIn} loggingOut={loggingOut} onLogout={onLogout} />
    </nav>
  );
};

export const SignedInBrand = ({ readOnly }: Readonly<{ readOnly: boolean }>): JSX.Element => (
  <Link
    className="application-brand"
    to={readOnly ? "/app/transactions" : "/app/dashboard"}
    search={{}}
  >
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

const ProductNavigation = ({
  prepareNavigation,
}: Readonly<{ prepareNavigation: (destination: string) => void }>): JSX.Element => (
  <>
    <SettingsNavigation prepareNavigation={prepareNavigation} />

    <Link
      to="/upgrade"
      onPointerEnter={() => prepareNavigation("/upgrade")}
      onPointerDownCapture={() => prepareNavigation("/upgrade")}
      onFocus={() => prepareNavigation("/upgrade")}
      onClick={dismissCompactNavigation}
      className="application-navigation-link"
      activeProps={{ className: "application-navigation-active" }}
    >
      <HugeiconsIcon icon={CrownIcon} size={22} strokeWidth={1.5} aria-hidden="true" />
      Suscripción
    </Link>
  </>
);

const ReadOnlyNotice = (): JSX.Element => (
  <div className="px-4 pb-4">
    <Badge variant="information">Solo lectura</Badge>
    <p className="mt-3 text-sm text-muted-foreground">Autorización de tratamiento retirada</p>
  </div>
);

const PrivacyLink = (): JSX.Element => (
  <Link
    to="/settings/privacy"
    onClick={dismissCompactNavigation}
    className="application-navigation-link"
    activeProps={{ className: "application-navigation-active" }}
  >
    <HugeiconsIcon icon={Shield01Icon} size={22} strokeWidth={1.5} aria-hidden="true" />
    Privacidad
  </Link>
);
