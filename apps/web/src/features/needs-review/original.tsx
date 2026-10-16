import type { CanonicalSuccess } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { sources } from "./model";
import type { Item } from "./model";

export const OriginalMaterial = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("ingestion", "getReviewMaterial", { params: { id: item.id } })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <details open className="min-w-0">
      <summary className="cursor-pointer text-sm font-semibold">
        Material original{" "}
        <span className="float-right text-xs font-normal text-muted-foreground">
          {sources[item.source]}
        </span>
      </summary>
      <div className="mt-5 min-w-0 overflow-hidden rounded-2xl border bg-card">
        <div className="border-b bg-muted/30 px-5 py-4 text-sm font-medium">
          {sources[item.source]} original
        </div>
        <div className="p-5">
          {state._tag === "Ready" ? (
            <MaterialBody material={state.value.data} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {state._tag === "Failure" ? "No pudimos cargar el original." : "Cargando original…"}
            </p>
          )}
          {state._tag === "Failure" ? (
            <Button type="button" variant="outline" onClick={refresh}>
              Reintentar original
            </Button>
          ) : null}
        </div>
        <p className="border-t px-5 py-4 text-xs text-muted-foreground">
          {item.status === "created"
            ? "Este material dio origen a una transacción."
            : "Este material aún no es una transacción."}
        </p>
      </div>
    </details>
  );
};
type Material = CanonicalSuccess<"ingestion.getReviewMaterial">["data"];
const MaterialBody = ({ material }: Readonly<{ material: Material }>): JSX.Element => {
  if (!material.available) {
    return (
      <p className="text-sm text-muted-foreground">
        {material.reason === "expired"
          ? "El original venció. Envía el material de nuevo para revisarlo."
          : "El original no está disponible. Puedes completar los datos manualmente mientras el elemento siga vigente. Una imagen puede conservar solo su descripción."}
      </p>
    );
  }
  return (
    <>
      <pre className="max-h-[65svh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-7 [overflow-wrap:anywhere]">
        {material.text}
      </pre>
      {material.truncated ? (
        <p className="mt-3 text-sm text-muted-foreground">Vista previa recortada.</p>
      ) : null}
    </>
  );
};
