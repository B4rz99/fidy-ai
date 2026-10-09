import { type AnyRootRoute, createRoute } from "@tanstack/react-router";
import { FeatureDetail } from "@/features/public-site/landing/feature-detail";
import { PublicHome } from "./home";
import { PublicSiteLayout } from "./layout";
import { PublicSiteNotFound } from "./not-found";
import { CookiesPolicy } from "@/features/public-site/legal/cookies";
import { Terms } from "@/features/public-site/legal/terms";
import { PrivacyPolicy } from "@/features/public-site/legal/privacy-policy";

/**
 * Creates the complete public website route subtree beneath the application root. Marketing,
 * audience, company, and legal pages stay private to this interface and share its website shell.
 */
export const createPublicSiteRoute = <TRootRoute extends AnyRootRoute>(rootRoute: TRootRoute) => {
  const publicSiteRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "public-site",
    component: PublicSiteLayout,
  });
  const homeRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "/",
    component: PublicHome,
  });
  const policyRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "/politica",
    component: PrivacyPolicy,
  });
  const cookiesRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "/cookies",
    component: CookiesPolicy,
  });
  const termsRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "/terminos",
    component: Terms,
  });
  const notFoundRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "$",
    component: PublicSiteNotFound,
  });

  const detailRoutes = [
    "transacciones",
    "presupuestos",
    "asistente",
    "tablero",
    "insights",
    "agentes",
  ].map((slug, index) =>
    createRoute({
      getParentRoute: () => publicSiteRoute,
      path: `/funciones/${slug}`,
      component: () => <FeatureDetail index={index} />,
    })
  );
  return publicSiteRoute.addChildren([
    homeRoute,
    policyRoute,
    cookiesRoute,
    termsRoute,
    notFoundRoute,
    ...detailRoutes,
  ]);
};
