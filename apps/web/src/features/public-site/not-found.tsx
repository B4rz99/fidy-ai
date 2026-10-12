import { Link } from "@tanstack/react-router";
import { PublicPageLayout } from "./page-layout";

/** Renders public website not-found behavior inside its shared layout. */
export const PublicSiteNotFound = (): React.JSX.Element => (
  <PublicPageLayout layout="centered">
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">Página no encontrada</h1>
      <Link className="text-muted-foreground underline underline-offset-4" to="/">
        Volver al inicio
      </Link>
    </div>
  </PublicPageLayout>
);
