import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import "./application.css";
import "./access.css";

const AccessFrame = (): JSX.Element => (
  <div data-access-root="">
    <div data-access-page="">
      <header data-access-header="">
        <Skeleton className="h-[61px] w-24" />
        <Skeleton className="size-11 rounded-full" />
      </header>
      <div data-access-layout="">
        <section data-access-brand="">
          <div className="grid gap-3">
            <Skeleton className="h-20 w-4/5" />
            <Skeleton className="h-20 w-3/4" />
            <Skeleton className="h-20 w-4/5" />
            <Skeleton className="h-20 w-2/3" />
          </div>
        </section>
        <main data-access-content="">
          <div className="grid gap-5">
            <Skeleton className="h-10 w-64 max-w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-[52px] w-full" />
            <Skeleton className="h-[52px] w-full" />
            <Skeleton className="my-4 h-5 w-full" />
            <Skeleton className="h-[52px] w-full" />
            <Skeleton className="h-[52px] w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        </main>
      </div>
    </div>
  </div>
);
const ApplicationFrame = (): JSX.Element => (
  <div className="application-shell">
    <aside className="application-sidebar">
      <div className="application-brand">
        <Skeleton className="h-[61px] w-24" />
      </div>
      <div className="grid flex-1 content-start gap-4">
        {[0, 1, 2, 3].map((link) => (
          <div key={link} className="application-navigation-link">
            <Skeleton className="size-5" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
        <div className="application-navigation-link">
          <Skeleton className="size-5" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="application-navigation-link">
          <Skeleton className="size-5" />
          <Skeleton className="h-5 w-28" />
        </div>
      </div>
      <Skeleton className="mb-3 h-11 w-full" />
    </aside>
    <main className="application-workspace">
      <div className="grid gap-6 px-[42px] py-[34px]">
        <Skeleton className="h-[45px] w-60" />
        <Skeleton className="h-11 w-full" />
      </div>
    </main>
  </div>
);
export const ApplicationSkeleton = ({
  surface,
}: Readonly<{ surface: "application" | "access" }>): JSX.Element => (
  <LoadingRegion label="Cargando aplicación">
    {surface === "access" ? <AccessFrame /> : <ApplicationFrame />}
  </LoadingRegion>
);
