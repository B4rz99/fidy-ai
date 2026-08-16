import { Link } from "@tanstack/react-router";
import { PublicPage } from "@/ui/public-page";

/** Renders the public not-found feature and its route back to the home feature. */
export const NotFoundFeature = (): React.JSX.Element => (
  <PublicPage layout="centered">
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">Página no encontrada</h1>
      <Link className="text-muted-foreground underline underline-offset-4" to="/">
        Volver al inicio
      </Link>
    </div>
  </PublicPage>
);
