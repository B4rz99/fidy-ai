import { lazyRouteComponent } from "@tanstack/react-router";

const PrivacyFeature = lazyRouteComponent(() => import("./feature"), "PrivacyFeature");

const PrivacyPreview = lazyRouteComponent(() => import("./dev-preview"), "PrivacyDataPreview");

export const PrivacyRoute = import.meta.env.DEV ? PrivacyPreview : PrivacyFeature;
