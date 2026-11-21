import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Cause, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type ComponentProps, type JSX, type ReactNode, useState } from "react";
import { useSession } from "@/session/session-context";
import { ApplicationSurface } from "@/ui/components/application";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { completeLogoutNavigation, createLogoutOperation } from "./logout";
import { SignedInBrand, SignedInNavigation } from "./navigation";
import { LogoutFailure } from "./logout-failure";
import { CompactNavigation } from "./compact-navigation";
import { useDesktopNavigation } from "./navigation-viewport";

export const AccessRefused = ({ withdrawn }: Readonly<{ withdrawn: boolean }>): JSX.Element => (
  <main className="mx-auto flex max-w-3xl flex-col items-start gap-6 px-5 py-12">
    <h1 className="text-2xl font-semibold tracking-tight">
      {withdrawn ? "Esta sección no está disponible" : "Acceso no autorizado"}
    </h1>
    <Alert variant={withdrawn ? "information" : "destructive"}>
      <AlertTitle>
        {withdrawn
          ? "Tu autorización de tratamiento está retirada"
          : "No pudimos autorizar esta acción"}
      </AlertTitle>
      <AlertDescription>
        {withdrawn
          ? "Puedes consultar gratis tus transacciones guardadas en modo de solo lectura. Esta consulta no reactiva el tratamiento de tus datos."
          : "Puedes intentar consultar tus transacciones guardadas o revisar Privacidad. Si tu sesión terminó, inicia sesión de nuevo."}
      </AlertDescription>
    </Alert>
    <div className="flex flex-wrap gap-3">
      <Button
        nativeButton={false}
        contentLayout="wrap"
        render={<Link to="/app/transactions" search={{}} />}
      >
        Ver mis transacciones
      </Button>
      <Button
        nativeButton={false}
        variant="outline"
        contentLayout="wrap"
        render={<Link to="/settings/privacy" />}
      >
        Revisar privacidad
      </Button>
    </div>
    <Button
      nativeButton={false}
      variant="link"
      size="label"
      render={<Link to="/login" reloadDocument />}
    >
      Iniciar sesión
    </Button>
  </main>
);

type ApplicationShellProps = Readonly<
  Pick<ComponentProps<"div">, "children"> & {
    readOnly: boolean;
    reviewPendingCount: ReactNode;
    prepareNavigation: (destination: string) => void;
  }
>;

export const ApplicationShell = ({
  children,
  readOnly,
  reviewPendingCount,
  prepareNavigation,
}: ApplicationShellProps): JSX.Element => {
  const desktop = useDesktopNavigation();
  const router = useRouter();
  const { completeLogout } = useSession();

  const logoutRequest = router.options.context.webAuthClient.pipe(
    Effect.flatMap((client) => client.browserLogin.logout())
  );

  const [logout] = useState(() =>
    router.options.context.webAuthClient.runtime.fn<{ onLoggedOut: () => void }>()(
      logoutRequest.pipe(createLogoutOperation)
    )
  );

  const status = useAtomValue(logout);
  const failed = AsyncResult.isFailure(status) && !Cause.hasInterruptsOnly(status.cause);
  const runLogout = useAtomSet(logout);

  const onLogout = (): void => {
    if (status.waiting) return;
    completeLogoutNavigation({
      completeLogout,
      navigate: () => router.navigate({ to: "/login", reloadDocument: true }),
      runLogout,
    });
  };

  return (
    <ApplicationSurface>
      <aside className="signed-in-sidebar application-sidebar">
        <SignedInBrand readOnly={readOnly} />
        {desktop ? (
          <div className="application-desktop-navigation">
            <SignedInNavigation
              readOnly={readOnly}
              loggingOut={status.waiting}
              onLogout={onLogout}
              reviewPendingCount={reviewPendingCount}
              prepareNavigation={prepareNavigation}
            />
          </div>
        ) : (
          <CompactNavigation
            readOnly={readOnly}
            loggingOut={status.waiting}
            onLogout={onLogout}
            reviewPendingCount={reviewPendingCount}
            prepareNavigation={prepareNavigation}
          />
        )}
        {failed ? <LogoutFailure /> : null}
      </aside>
      <div className="application-workspace">{children}</div>
    </ApplicationSurface>
  );
};

export const SignedInContent = ({
  children,
}: Readonly<Pick<ComponentProps<"div">, "children">>): JSX.Element => {
  const { authentication } = useSession();

  return authentication === "expired" ? <AccessRefused withdrawn={false} /> : <>{children}</>;
};
