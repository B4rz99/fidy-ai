import { Link, Outlet, useLocation } from "@tanstack/react-router";

/** Renders navigation and shared presentation for the public website. */
export const PublicSiteLayout = (): React.JSX.Element => {
  const path = useLocation({ select: (location) => location.pathname });
  if (path === "/" || path.startsWith("/funciones/")) return <Outlet />;
  return (
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
};
