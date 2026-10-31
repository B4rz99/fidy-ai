import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import "./settings.css";
import "./oauth-review.css";

export const AuthorizationSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando solicitud">
    <div className="settings-columns">
      <div className="settings-main">
        <section className="oauth-client">
          <Skeleton className="size-[58px] rounded-full" />
          <h2 className="settings-section-title">
            <Skeleton className="h-[31px] w-52" />
          </h2>
          <div className="oauth-client-body">
            <Skeleton className="mb-2 h-[55px] w-full" />
            <div className="oauth-permissions">
              <Skeleton className="h-[35px] w-52" />
              {[0, 1, 2].map((permission) => (
                <div key={permission} className="oauth-permission">
                  <Skeleton className="size-7 shrink-0" />
                  <div className="grid flex-1 gap-[6px]">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-6 w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
      <aside className="settings-panel oauth-panel">
        <div className="oauth-panel-heading">
          <Skeleton className="h-[33px] w-52" />
          <Skeleton className="mt-[6px] h-[22px] w-full" />
        </div>
        <div className="oauth-duration">
          {[0, 1, 2, 3].map((duration) => (
            <Skeleton key={duration} data-slot="button" className="h-11 w-full" />
          ))}
        </div>
        <div className="oauth-expiration">
          <Skeleton className="h-[22px] w-40" />
          <Skeleton className="h-[22px] w-52" />
        </div>
        <Skeleton className="h-[22px] w-full" />
        <div className="grid gap-2">
          <Skeleton className="h-[22px] w-full" />
          <Skeleton className="h-[22px] w-3/4" />
        </div>
        <div className="oauth-actions">
          <Skeleton data-slot="button" className="h-11 w-full" />
          <Skeleton data-slot="button" className="h-11 w-full" />
        </div>
      </aside>
    </div>
  </LoadingRegion>
);
