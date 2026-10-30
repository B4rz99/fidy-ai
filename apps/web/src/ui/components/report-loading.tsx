import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import "./recurring-report.css";

export const ReportSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando informe">
    <div className="recurring-report-columns">
      <div className="recurring-report-main">
        <section className="recurring-report-heading">
          <Skeleton className="size-[58px] shrink-0 rounded-full" />
          <div className="grid gap-[6px]">
            <Skeleton className="h-[31px] w-56" />
            <Skeleton className="h-[21px] w-72 max-w-full" />
          </div>
        </section>
        <div className="recurring-report-items">
          <div className="recurring-report-labels">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="ml-auto h-5 w-20" />
          </div>
          <ul>
            {[0, 1, 2, 3].map((row) => (
              <li key={row}>
                <Skeleton className="h-6 w-40 max-w-full" />
                <Skeleton className="h-[21px] w-20" />
                <Skeleton className="ml-auto h-6 w-32" />
              </li>
            ))}
          </ul>
        </div>
      </div>
      <aside className="recurring-report-context">
        <div className="recurring-report-metadata">
          <h2>
            <Skeleton className="h-[33px] w-48" />
          </h2>
          <Skeleton className="h-[64px] w-full" />
          <dl>
            {[0, 1].map((fact) => (
              <div key={fact}>
                <dt>
                  <Skeleton className="h-5 w-36" />
                </dt>
                <dd>
                  <Skeleton className="h-6 w-44" />
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="recurring-report-footer">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="mt-2 h-5 w-3/4" />
        </p>
      </aside>
    </div>
  </LoadingRegion>
);
