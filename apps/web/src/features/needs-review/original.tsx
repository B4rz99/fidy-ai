import { useReviewExpired } from "./expiry";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess } from "@/transport/client";
import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import type { Item } from "./model";

export const OriginalMaterial = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  const expired = useReviewExpired(item);
  return expired ? (
    <p className="text-sm text-muted-foreground">
      El original venció. Envía el material de nuevo para revisarlo.
    </p>
  ) : (
    <RetainedMaterial item={item} />
  );
};
const useMaterialQuery = (
  item: Item
): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewMaterial">, unknown>> => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("ingestion", "getReviewMaterial", {
      params: { id: item.id },
      reactivityKeys: ["ingestion-review"],
    })
  );
  return query;
};
/** Load original bytes alongside the selected detail, within the same expiry fence. */
export const ReviewMaterialPreload = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  useAtomMount(useMaterialQuery(item));
  return <></>;
};
const RetainedMaterial = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  const query = useMaterialQuery(item);
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <details open data-review="original">
      <summary>
        Material original
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} aria-hidden="true" />
      </summary>
      <div data-review="original-body">
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
      <p data-review="original-footer">
        {item.status === "created"
          ? "Este material dio origen a una transacción."
          : "Este material aún no es una transacción."}
      </p>
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
      <pre className="max-h-[45svh] lg:max-h-[calc(100dvh-29rem)] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-7 [overflow-wrap:anywhere]">
        {material.text}
      </pre>
      {material.truncated ? (
        <p className="mt-3 text-sm text-muted-foreground">Vista previa recortada.</p>
      ) : null}
    </>
  );
};
