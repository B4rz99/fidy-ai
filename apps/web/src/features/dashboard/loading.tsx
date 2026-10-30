import type { JSX } from "react";
import { Skeleton } from "@/ui/components/skeleton";

export const LoadingDashboard = (): JSX.Element => (
  <main
    className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8"
    aria-label="Cargando tablero"
    aria-live="polite"
  >
    <Skeleton className="h-12 w-64" />
    <Skeleton className="h-80 w-full" />
  </main>
);
