import type { CanonicalSuccess } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import type { Item } from "./model";

export const OriginalMaterial = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("ingestion", "getReviewMaterial", { params: { id: item.id } })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <details open className="min-w-0 border-b bg-muted/30 p-5 xl:border-r xl:border-b-0">
      <summary className="cursor-pointer text-base font-medium">Material original</summary>
      <div className="mt-4 min-w-0">
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
      <pre className="max-h-[65svh] overflow-auto whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
        {material.text}
      </pre>
      {material.truncated ? (
        <p className="mt-3 text-sm text-muted-foreground">Vista previa recortada.</p>
      ) : null}
    </>
  );
};
