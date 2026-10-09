import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CreditCardIcon,
  Home01Icon,
  Menu01Icon,
  Settings01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Cause, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { JSX, MouseEvent } from "react";
import { useSession } from "@/session/session-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { FidyWordmark } from "@/ui/components/wordmark";
import { completeLogoutNavigation, makeLogoutOperation } from "./logout";

/** Explains the authentication-lifetime transition without exposing or retaining credentials. */
export const AuthenticationExpired = (): JSX.Element => (
  <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
    <Alert className="max-w-md" variant="destructive">
      <AlertTitle>Sesión vencida</AlertTitle>
      <AlertDescription>Tu sesión venció. Inicia sesión de nuevo.</AlertDescription>
    </Alert>
  </main>
);

const navigationLinks = [
  { to: "/app/dashboard", label: "Tablero", icon: Home01Icon },
  { to: "/app/transactions", label: "Transacciones", icon: CreditCardIcon },
  { to: "/app/agent", label: "Agente", icon: SparklesIcon },
] as const;
const settingsLinks = [
  { to: "/settings/email", label: "Correo" },
  { to: "/settings/pats", label: "Tokens personales (PAT)" },
  { to: "/settings/agents", label: "Agentes conectados" },
  { to: "/settings/recovery", label: "Recuperación" },
] as const;
const dismissCompactNavigation = (event: MouseEvent<HTMLAnchorElement>): void => {
  event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
};
const SignedInNavigation = ({
  onLogout,
  loggingOut,
}: Readonly<{
  onLogout: () => void;
  loggingOut: boolean;
}>): JSX.Element => (
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
      </Link>
    ))}
    <details className="shrink-0">
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
    <Button
      className="justify-start md:mt-auto"
      disabled={loggingOut}
      onClick={onLogout}
      type="button"
      variant="ghost"
    >
      {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
    </Button>
  </nav>
);

const CompactNavigation = ({
  loggingOut,
  onLogout,
}: Readonly<{ loggingOut: boolean; onLogout: () => void }>): JSX.Element => (
  <>
    <div className="px-5 md:hidden">
      <Button
        variant="outline"
        size="icon"
        popoverTarget="signed-in-navigation"
        aria-label="Menú de navegación"
      >
        <HugeiconsIcon
          className="signed-in-menu-bars"
          icon={Menu01Icon}
          size={24}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <HugeiconsIcon
          className="signed-in-menu-close"
          icon={Cancel01Icon}
          size={24}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </Button>
    </div>
    <div id="signed-in-navigation" className="signed-in-compact-navigation" popover="auto">
      <SignedInNavigation loggingOut={loggingOut} onLogout={onLogout} />
    </div>
  </>
);

const SignedInShell = (): JSX.Element => {
  const router = useRouter();
  const { completeLogout } = useSession();
  const logoutRequest = router.options.context.webAuthClient.pipe(
    Effect.flatMap((client) => client.browserLogin.logout())
  );
  const [logout] = useState(() =>
    router.options.context.webAuthClient.runtime.fn<{ onLoggedOut: () => void }>()(
      logoutRequest.pipe(makeLogoutOperation)
    )
  );
  const status = useAtomValue(logout);
  const failed = AsyncResult.isFailure(status) && !Cause.hasInterruptsOnly(status.cause);
  const runLogout = useAtomSet(logout);
  const onLogout = (): void => {
    if (status.waiting) return;
    completeLogoutNavigation({
      completeLogout,
      navigate: () => router.navigate({ to: "/auth/pair" }),
      runLogout,
    });
  };

  return (
    <div className="signed-in-theme min-h-svh bg-background md:flex">
      <aside className="signed-in-sidebar flex items-center justify-between border-b bg-muted/30 md:sticky md:top-0 md:h-svh md:w-60 md:flex-none md:flex-col md:items-stretch md:border-r md:border-b-0">
        <Link className="flex shrink-0 flex-col items-start gap-2 px-6 py-4" to="/app/dashboard">
          <FidyWordmark />
          <span className="hidden text-xs text-muted-foreground md:block">
            Tu dinero, más claro
          </span>
        </Link>
        <div className="hidden min-h-0 flex-1 md:flex">
          <SignedInNavigation loggingOut={status.waiting} onLogout={onLogout} />
        </div>
        <CompactNavigation loggingOut={status.waiting} onLogout={onLogout} />
        {failed ? (
          <Alert className="m-3" variant="destructive" role="alert">
            <AlertTitle>No pudimos confirmar el cierre de sesión</AlertTitle>
            <AlertDescription>
              Revisa tu conexión e intenta cerrar sesión de nuevo.
            </AlertDescription>
          </Alert>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
};

/** Authenticated route layout whose child server state shares one authentication lifetime. */
export const SignedInFeature = (): JSX.Element => {
  const { authentication } = useSession();
  return authentication === "expired" ? <AuthenticationExpired /> : <SignedInShell />;
};
