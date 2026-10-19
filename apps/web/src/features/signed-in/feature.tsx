import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Cause, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type ComponentProps, type JSX, type ReactNode, useState } from "react";
import { useSession } from "@/session/session-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { completeLogoutNavigation, makeLogoutOperation } from "./logout";
import { SignedInBrand, SignedInNavigation } from "./navigation";
import { LogoutFailure } from "./logout-failure";
import { CompactNavigation } from "./compact-navigation";
import { useDesktopNavigation } from "./navigation-viewport";

export const AccessRefused = (): JSX.Element => (
  <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
    <Alert className="max-w-md" variant="destructive">
      <AlertTitle>Acceso no autorizado</AlertTitle>
      <AlertDescription>
        <p>No pudimos autorizar esta acción.</p>
        <p>
          Si retiraste tu autorización de tratamiento, puedes consultar tus datos desde Privacidad.
          En otro caso, intenta iniciar sesión de nuevo.
        </p>
        <Link to="/settings/privacy" className="underline">
          Revisar privacidad
        </Link>
        <Link to="/auth/pair" className="underline">
          Iniciar sesión
        </Link>
      </AlertDescription>
    </Alert>
  </main>
);

/** Shared application navigation; privacy routes can retain it independently of product access. */
export const ApplicationShell = ({
  children,
  reviewPendingCount,
}: Readonly<
  Pick<ComponentProps<"div">, "children"> & { reviewPendingCount: ReactNode }
>): JSX.Element => {
  const desktop = useDesktopNavigation();
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
        <SignedInBrand />
        {desktop ? (
          <div className="hidden min-h-0 flex-1 md:flex">
            <SignedInNavigation
              loggingOut={status.waiting}
              onLogout={onLogout}
              reviewPendingCount={reviewPendingCount}
            />
          </div>
        ) : (
          <CompactNavigation
            loggingOut={status.waiting}
            onLogout={onLogout}
            reviewPendingCount={reviewPendingCount}
          />
        )}
        {failed ? <LogoutFailure /> : null}
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
        {children}
      </div>
    </div>
  );
};

/** Refuses expired authentication without adding navigation around an already composed application shell. */
export const SignedInContent = ({
  children,
}: Readonly<Pick<ComponentProps<"div">, "children">>): JSX.Element => {
  const { authentication } = useSession();
  return authentication === "expired" ? <AccessRefused /> : <>{children}</>;
};
