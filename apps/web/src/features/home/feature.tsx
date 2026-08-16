import { PublicPage } from "@/ui/public-page";

/** Renders the public home feature without owning routing, transport, or session state. */
export const HomeFeature = (): React.JSX.Element => (
  <PublicPage layout="centered">
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-muted-foreground">
        Finanzas personales, con claridad.
      </p>
      <h1 className="font-heading text-5xl font-semibold tracking-tight">Fidy</h1>
    </div>
  </PublicPage>
);
