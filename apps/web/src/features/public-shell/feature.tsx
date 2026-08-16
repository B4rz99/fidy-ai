import type { JSX } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { PublicShell } from "@/ui/public-shell";

/** Renders the public product shell while leaving its visual structure to an ownerless primitive. */
export const PublicShellFeature = (): JSX.Element => (
  <PublicShell
    ariaLabel="Principal"
    brand={
      <Link className="font-heading text-xl font-semibold" to="/">
        fidy
      </Link>
    }
    navigation={
      <Link className="text-sm text-muted-foreground hover:text-foreground" to="/politica">
        Política de privacidad
      </Link>
    }
  >
    <Outlet />
  </PublicShell>
);
