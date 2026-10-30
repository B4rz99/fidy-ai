import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Card, CardContent, CardHeader, CardTitle } from "./card";
import "./settings.css";

export const AccessListSkeleton = ({
  kind,
}: Readonly<{ kind: "tokens" | "agents" }>): JSX.Element => {
  const columns =
    kind === "tokens"
      ? ["Nombre", "Permisos", "Creado", "Último uso", "Vence", "Acción"]
      : ["Nombre", "Permisos", "Estado", "Vence", "Acción"];
  return (
    <LoadingRegion label={kind === "tokens" ? "Cargando tokens activos" : "Cargando agentes"}>
      <div className="settings-table" data-settings-desktop>
        <Table className={kind === "tokens" ? "min-w-[42rem]" : "min-w-[36rem]"}>
          <TableHeader>
            <TableRow>
              {columns.map((name) => (
                <TableHead density="compact" key={name}>
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[0, 1, 2].map((row) => (
              <TableRow key={row}>
                {columns.map((name) => (
                  <TableCell density="compact" key={name}>
                    <Skeleton
                      data-slot={name === "Acción" ? "button" : "skeleton"}
                      className={name === "Permisos" ? "h-9 w-32" : "h-6 w-24"}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div data-settings-mobile-list>
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid gap-3 border-b py-5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
};
export const PATCreationSkeleton = (): JSX.Element => (
  <LoadingRegion label="Comprobando tu identidad">
    <section className="settings-token-creation">
      <h2 className="settings-panel-title">Crear token</h2>
      <div className="settings-token-form">
        <div className="grid gap-2">
          <Skeleton className="h-[1lh] w-16 text-sm leading-none" />
          <Skeleton data-slot="input" className="h-11 w-full" />
          <Skeleton className="h-[21px] w-full" />
        </div>
        <div>
          <Skeleton className="mb-2 h-6 w-20" />
          {[0, 1, 2].map((scope) => (
            <div key={scope} className="settings-scope-option">
              <Skeleton data-slot="checkbox" className="size-5 shrink-0" />
              <div className="grid flex-1 gap-1">
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-[21px] w-full" />
              </div>
            </div>
          ))}
        </div>
        <fieldset className="settings-token-lifetime">
          <legend className="font-medium">
            <Skeleton className="h-[1lh] w-20" />
          </legend>
          <Skeleton data-slot="dropdown-menu-trigger" className="inline-flex h-11 w-full" />
        </fieldset>
        <div className="settings-token-submit">
          <Skeleton data-slot="button" className="h-11 w-full" />
          <Skeleton className="h-[21px] w-full" />
        </div>
      </div>
    </section>
  </LoadingRegion>
);
export const PairingRequestSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando solicitud">
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Confirma el acceso</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-10 w-full" />
        <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          {[0, 1, 2, 3].map((detail) => (
            <div key={detail} className="contents">
              <dt>
                <Skeleton className="h-6 w-36" />
              </dt>
              <dd>
                <Skeleton className="h-6 w-40" />
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 w-40" />
        </div>
      </CardContent>
    </Card>
  </LoadingRegion>
);
export const BankRequestSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando solicitud">
    <div className="flex w-full max-w-md flex-col gap-3">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-7 w-4/5" />
          </CardTitle>
          <Skeleton className="h-10 w-full" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </CardContent>
      </Card>
      <Skeleton className="h-11 w-full" />
    </div>
  </LoadingRegion>
);
export const ConsentDisclosureSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando información de Consentimiento">
    <div data-access-consent-check="" className="flex items-start gap-3">
      <Skeleton className="mt-0.5 size-5 shrink-0" />
      <div className="grid flex-1 gap-[7px]">
        <Skeleton className="h-[15px] w-full" />
        <Skeleton className="h-[15px] w-4/5" />
      </div>
    </div>
  </LoadingRegion>
);

export const PrivacyAuthorizationSkeleton = (): JSX.Element => (
  <LoadingRegion label="Consultando autorización">
    <div className="settings-section-actions">
      <div className="flex items-center gap-3">
        <Skeleton data-slot="checkbox" className="size-5 shrink-0" />
        <Skeleton className="h-6 w-full" />
      </div>
      <div>
        <Skeleton data-slot="button" className="h-11 w-48" />
      </div>
    </div>
  </LoadingRegion>
);
export const ConsentRenewalSkeleton = (): JSX.Element => (
  <LoadingRegion label="Consultando aviso para renovar">
    <section className="flex flex-col gap-4 border-t pt-6">
      <h2 className="text-xl font-semibold">Volver a autorizar</h2>
      <div className="grid gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-6 w-3/4" />
      <div className="flex items-center gap-3">
        <Skeleton data-slot="checkbox" className="size-5 shrink-0" />
        <Skeleton className="h-6 w-full" />
      </div>
      <div>
        <Skeleton data-slot="button" className="h-11 w-48" />
      </div>
    </section>
  </LoadingRegion>
);
