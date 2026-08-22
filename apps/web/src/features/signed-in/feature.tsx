import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import type { JSX } from "react";
import { useSession } from "@/session/session-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Spinner } from "@/ui/components/spinner";
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

const CurrentUserCard = ({
  locale,
  timeZone,
  onLogout,
}: Readonly<{ locale: string; timeZone: string; onLogout: () => void }>): JSX.Element => (
  <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>
          <h1 className="text-2xl">Tu contexto de Fidy</h1>
        </CardTitle>
        <CardDescription>
          Estos valores controlan cómo Fidy presenta e interpreta tu información.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-4">
            <dt className="text-sm text-muted-foreground">Idioma y región</dt>
            <dd className="mt-1 font-medium">{locale}</dd>
          </div>
          <div className="rounded-lg border p-4">
            <dt className="text-sm text-muted-foreground">Zona horaria</dt>
            <dd className="mt-1 font-medium">{timeZone}</dd>
          </div>
        </dl>
        <Button className="mt-6 w-full" onClick={onLogout} type="button" variant="outline">
          Cerrar sesión
        </Button>
      </CardContent>
    </Card>
  </main>
);

type CurrentUserResult = AsyncResult.AsyncResult<
  Readonly<{ data: Readonly<{ locale: string; timeZone: string }> }>,
  unknown
>;

/** Renders the complete current-User query state without owning transport or session effects. */
export const CurrentUserResultView = ({
  onLogout,
  result,
}: Readonly<{ onLogout: () => void; result: CurrentUserResult }>): JSX.Element => {
  if (AsyncResult.isSuccess(result)) {
    return (
      <CurrentUserCard
        locale={result.value.data.locale}
        onLogout={onLogout}
        timeZone={result.value.data.timeZone}
      />
    );
  }

  if (AsyncResult.isFailure(result)) {
    return (
      <main className="flex min-h-svh items-center justify-center px-4">
        <Alert className="max-w-md" variant="destructive">
          <AlertTitle>No pudimos cargar tu perfil</AlertTitle>
          <AlertDescription>Intenta de nuevo en unos momentos.</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center" aria-label="Cargando perfil">
      <Spinner />
    </main>
  );
};

const CurrentUserShell = (): JSX.Element => {
  const router = useRouter();
  const { completeLogout } = useSession();
  const [currentUser] = useState(() =>
    router.options.context.apiClient.query("identity", "getCurrentUser", {})
  );
  const logoutRequest = router.options.context.webAuthClient.pipe(
    Effect.flatMap((client) => client.browserLogin.logout())
  );
  const [logout] = useState(() =>
    router.options.context.webAuthClient.runtime.fn<{ onLoggedOut: () => void }>()(
      logoutRequest.pipe(makeLogoutOperation)
    )
  );
  const result = useAtomValue(currentUser);
  const runLogout = useAtomSet(logout);
  const onLogout = completeLogoutNavigation.bind(undefined, {
    completeLogout,
    navigate: () => router.navigate({ to: "/auth/pair" }),
    runLogout,
  });

  return <CurrentUserResultView onLogout={onLogout} result={result} />;
};

/** Authenticated shell whose server state is owned exclusively by the derived query Atom. */
export const SignedInFeature = (): JSX.Element => {
  const { authentication } = useSession();
  return authentication === "expired" ? <AuthenticationExpired /> : <CurrentUserShell />;
};
