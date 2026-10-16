import { useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { DashboardFeature } from "@/features/dashboard/feature";

export const DashboardPage = (): JSX.Element => (
  <DashboardFeature apiClient={useRouter().options.context.apiClient} />
);
