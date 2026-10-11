import type { ViewConfiguration, ViewContent } from "./model";
import { HomeContent } from "@/features/public-site/native/landing/home-content";
import "../landing/landing.css";

/** Presents the approved public landing and local-only product demonstrations. */
export const PublicHome = (configuration: ViewConfiguration): ViewContent => [
  ...HomeContent({
    ...configuration,
  }),
];
