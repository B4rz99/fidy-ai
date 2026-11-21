import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { useSession } from "@/session/session-context";
import { buttonVariants } from "@/ui/components/button-variants";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from "@/ui/components/empty";

export const PageNotFound = (): JSX.Element => {
  const { authentication } = useSession();
  const { sessionBinding } = useRouter().options.context;

  const appRoute = useRouterState({
    select: (state) =>
      state.location.pathname === "/app" || state.location.pathname.startsWith("/app/"),
  });

  const returnToDashboard = appRoute && authentication !== "expired" && sessionBinding !== "none";

  return (
    <main
      aria-labelledby="missing-page-title"
      className="flex min-h-[60svh] items-center justify-center px-5 py-12"
    >
      <Empty>
        <EmptyHeader>
          <h1 id="missing-page-title" className="text-2xl font-semibold tracking-tight">
            Página no encontrada
          </h1>
          <EmptyDescription>
            No encontramos la página que buscas.
            <br />
            {returnToDashboard
              ? "Puedes volver al tablero para continuar."
              : "Puedes volver al sitio web de Fidy."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {returnToDashboard ? (
            <Link to="/app/dashboard" className={buttonVariants({ contentLayout: "wrap" })}>
              Volver al tablero
            </Link>
          ) : (
            <a href="https://fidyapp.com/" className={buttonVariants({ contentLayout: "wrap" })}>
              Ir al sitio web de Fidy
            </a>
          )}
        </EmptyContent>
      </Empty>
    </main>
  );
};
