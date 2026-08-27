import { useAtomSet } from "@effect/atom-react";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Effect } from "effect";
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
  const runLogout = useAtomSet(logout);
  const onLogout = completeLogoutNavigation.bind(undefined, {
    completeLogout,
    navigate: () => router.navigate({ to: "/auth/pair" }),
    runLogout,
  });

  return (
    <div className="min-h-svh bg-muted/30 md:flex">
      <aside className="flex border-b bg-background md:sticky md:top-0 md:h-svh md:w-56 md:flex-none md:flex-col md:border-r md:border-b-0">
        <Link className="px-5 py-5 font-heading text-xl font-semibold" to="/app/dashboard">
          Fidy
        </Link>
        <nav
          aria-label="Aplicación"
          className="flex flex-1 flex-wrap items-center gap-1 px-3 pb-3 md:flex-col md:items-stretch"
        >
          <Button className="justify-start" render={<Link to="/app/dashboard" />} variant="ghost">
            Tablero
          </Button>
          <Button
            className="justify-start"
            render={<Link to="/app/transactions" />}
            variant="ghost"
          >
            Transacciones
          </Button>
          <Button className="justify-start" render={<Link to="/settings/email" />} variant="ghost">
            Correo
          </Button>
          <Button className="justify-start" render={<Link to="/settings/pats" />} variant="ghost">
            Tokens
          </Button>
          <Button
            className="justify-start md:mt-auto"
            onClick={onLogout}
            type="button"
            variant="outline"
          >
            Cerrar sesión
          </Button>
        </nav>
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
