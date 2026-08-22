import { useAtomSet } from "@effect/atom-react";
import { Outlet, useRouter } from "@tanstack/react-router";
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
    <div className="min-h-svh bg-muted/30">
      <header className="border-b bg-background">
        <nav
          aria-label="Aplicación"
          className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8"
        >
          <span className="font-heading text-xl font-semibold">Fidy</span>
          <Button onClick={onLogout} type="button" variant="outline">
            Cerrar sesión
          </Button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
};

/** Authenticated route layout whose child server state shares one authentication lifetime. */
export const SignedInFeature = (): JSX.Element => {
  const { authentication } = useSession();
  return authentication === "expired" ? <AuthenticationExpired /> : <SignedInShell />;
};
