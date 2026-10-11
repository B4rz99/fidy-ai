import { type AnyRootRoute, createRoute } from "@tanstack/react-router";
import { PublicPage } from "./route-adapter";

/** Registers the public destinations; each page mounts the native Foldkit program. */
export const createPublicSiteRoute = <TRootRoute extends AnyRootRoute>(rootRoute: TRootRoute) => {
  const publicSiteRoute = createRoute({ getParentRoute: () => rootRoute, id: "public-site" });
  const paths = [
    "/",
    "/politica",
    "/cookies",
    "/terminos",
    "$",
    ...["transacciones", "presupuestos", "asistente", "tablero", "insights", "agentes"].map(
      (slug) => `/funciones/${slug}`
    ),
  ];
  return publicSiteRoute.addChildren(
    paths.map((path) =>
      createRoute({
        getParentRoute: () => publicSiteRoute,
        path,
        component: PublicPage,
      })
    )
  );
};
