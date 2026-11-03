import { lazyRouteComponent } from "@tanstack/react-router";

export const TransactionWorkspace = lazyRouteComponent(
  () => import("./workspace"),
  "TransactionWorkspace"
);
