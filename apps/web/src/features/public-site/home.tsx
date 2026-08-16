import { PublicPageLayout } from "./page-layout";

/** Renders the public website home page. */
export const PublicHome = (): React.JSX.Element => (
  <PublicPageLayout layout="centered">
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-muted-foreground">
        Finanzas personales, con claridad.
      </p>
      <h1 className="font-heading text-5xl font-semibold tracking-tight">Fidy</h1>
    </div>
  </PublicPageLayout>
);
