import { useAtomValue } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  CreditCardIcon,
  Home01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type JSX, type ReactNode, useState } from "react";
import { useSession } from "@/session/session-context";
import { FidyWordmark } from "@/ui/components/wordmark";
import { Button } from "@/ui/components/button";
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
}: Readonly<{
  onLogout: () => void;
  loggingOut: boolean;
  reviewPendingCount: ReactNode;
}>): JSX.Element => {
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  const client = useRouter().options.context.webAuthClient;
  const [binding] = useState(() => client.query("browserSession", "binding", {}));
  const session = useAtomValue(binding);
  const signedIn =
    authentication !== "expired" &&
    AsyncResult.isSuccess(session) &&
    Option.isSome(Option.fromNullishOr(session.value.binding));
  return (
    <nav aria-label="Aplicación" className="flex min-w-0 flex-1 flex-col gap-2 px-3 pb-3">
      {navigationLinks.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          search={{}}
          onClick={dismissCompactNavigation}
          className="flex min-h-12 shrink-0 items-center gap-4 rounded-md px-4 py-3 text-base text-muted-foreground hover:bg-muted"
          activeProps={{ className: "bg-secondary text-secondary-foreground font-medium" }}
        >
          <HugeiconsIcon icon={link.icon} size={24} strokeWidth={1.5} aria-hidden="true" />
          {link.label}
          {link.to === "/app/needs-review" && signedIn && !privacy ? reviewPendingCount : null}
        </Link>
      ))}
      <SettingsNavigation />
      {signedIn ? (
        <Button
          className="justify-start md:mt-auto"
          disabled={loggingOut}
          onClick={onLogout}
          type="button"
          variant="ghost"
        >
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </Button>
      ) : (
        <Button className="justify-start md:mt-auto" variant="ghost" render={<Link to="/login" />}>
          Iniciar sesión
        </Button>
      )}
    </nav>
  );
};

export const SignedInBrand = (): JSX.Element => (
  <Link className="flex shrink-0 flex-col items-start gap-2 px-3 py-4 md:px-6" to="/app/dashboard">
    <FidyWordmark />
    <span className="hidden text-xs text-muted-foreground md:block">Tu dinero, más claro</span>
  </Link>
);
