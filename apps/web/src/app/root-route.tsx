import { Link, Outlet } from "@tanstack/react-router";
import type { JSX } from "react";
import { PublicPage } from "@/ui/public-page";

/** Renders the application-owned public shell around every public route. */
export const RootRoute = (): JSX.Element => (
  <div className="min-h-svh bg-background text-foreground">
    <header className="border-b">
      <nav
        className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5"
        aria-label="Principal"
      >
        <Link className="font-heading text-xl font-semibold" to="/">
          fidy
        </Link>
        <Link className="text-sm text-muted-foreground hover:text-foreground" to="/politica">
          Política de privacidad
        </Link>
      </nav>
    </header>
    <Outlet />
  </div>
);

/** Renders the application-owned not-found presentation for unknown public routes. */
export const RootNotFound = (): JSX.Element => (
  <PublicPage layout="centered">
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">Página no encontrada</h1>
      <Link className="text-muted-foreground underline underline-offset-4" to="/">
        Volver al inicio
      </Link>
    </div>
  </PublicPage>
);
