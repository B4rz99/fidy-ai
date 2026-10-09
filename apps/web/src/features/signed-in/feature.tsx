import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Cause, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { JSX } from "react";
import { useSession } from "@/session/session-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
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
  { to: "/app/dashboard", label: "Tablero" },
  { to: "/app/agent", label: "Agente" },
  { to: "/app/transactions", label: "Transacciones" },
  { to: "/settings/email", label: "Correo" },
  { to: "/settings/pats", label: "Tokens personales (PAT)" },
  { to: "/settings/agents", label: "Agentes conectados" },
  { to: "/settings/recovery", label: "Recuperación" },
] as const;

const SignedInNavigation = ({
  onLogout,
  loggingOut,
}: {
  readonly onLogout: () => void;
  readonly loggingOut: boolean;
}): JSX.Element => (
  <nav
    aria-label="Aplicación"
    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:items-stretch"
  >
    {navigationLinks.map((link) => (
      <Button
        key={link.to}
        nativeButton={false}
        className="shrink-0 justify-start"
        render={<Link to={link.to} search={{}} activeProps={{ className: "bg-muted" }} />}
        variant="ghost"
      >
        {link.label}
      </Button>
    ))}
    <Button
      className="justify-start md:mt-auto"
      disabled={loggingOut}
      onClick={onLogout}
      type="button"
      variant="outline"
    >
      {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
    </Button>
  </nav>
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
    <div className="min-h-svh bg-muted/30 md:flex">
      <aside className="flex border-b bg-background md:sticky md:top-0 md:h-svh md:w-56 md:flex-none md:flex-col md:border-r md:border-b-0">
        <Link className="px-5 py-5 font-heading text-xl font-semibold" to="/app/dashboard">
          Fidy
        </Link>
        <SignedInNavigation loggingOut={status.waiting} onLogout={onLogout} />
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
