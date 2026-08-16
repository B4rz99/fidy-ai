import { type AnyRootRoute, createRoute } from "@tanstack/react-router";
import { PublicHome } from "./home";
import { PublicSiteLayout } from "./layout";
import { PublicSiteNotFound } from "./not-found";
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
  const notFoundRoute = createRoute({
    getParentRoute: () => publicSiteRoute,
    path: "$",
    component: PublicSiteNotFound,
  });

  return publicSiteRoute.addChildren([homeRoute, policyRoute, notFoundRoute]);
};
