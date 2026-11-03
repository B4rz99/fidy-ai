import { useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { DashboardFeature } from "@/features/dashboard/feature";
import { DestinationCodePreload } from "./destination-code-preload";

export const DashboardPage = (): JSX.Element => (
  <DashboardFeature apiClient={useRouter().options.context.apiClient}>
    <DestinationCodePreload />
  </DashboardFeature>
);

DashboardPage.preloadData = DashboardFeature.preloadData;
