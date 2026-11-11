import { PendingRead } from "@/ui/components/pending-read";
import { Input } from "@/ui/components/input";

import { earlierOriginalDeadline, originalDeadlineQuery } from "./original-deadline";
import { reviewMaterialQuery } from "./material-query";
import { reviewHasExpired, useReviewExpired } from "./expiry";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess } from "@/transport/client";
import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useId, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import type { Item } from "./model";

export const OriginalMaterial = ({
  item,
  expiresAt,
}: Readonly<{
  item: Item;
  expiresAt: Item["expiresAt"];
}>): JSX.Element => {
  const deadline = useOriginalDeadline(item, expiresAt);
  const expired = useReviewExpired({ ...item, expiresAt: deadline });
  return expired ? (
    <ExpiredOriginal />
  ) : (
    <RetainedMaterial item={{ ...item, expiresAt: deadline }} />
  );
};
const useOriginalDeadline = (item: Item, expiresAt: Item["expiresAt"]): Item["expiresAt"] => {
  const query = originalDeadlineQuery({
    ...item,
    expiresAt: earlierOriginalDeadline({ first: item.expiresAt, second: expiresAt }),
  });
  return useAtomValue(query);
};
const ExpiredOriginal = (): JSX.Element => (
  <p className="text-sm text-muted-foreground">
    El original venció. Envía el material de nuevo para revisarlo.
  </p>
);
const useMaterialQuery = (
  item: Item
): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewMaterial">, unknown>> => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    reviewMaterialQuery({
      client,
      item,
    })
  );
  return query;
};
/** Load original bytes alongside the selected detail, within the same expiry fence. */
export const ReviewMaterialPreload = ({
  item,
  expiresAt,
}: Readonly<{
  item: Item;
  expiresAt: Item["expiresAt"];
}>): JSX.Element => {
  const deadline = useOriginalDeadline(item, expiresAt);
  const expired = useReviewExpired({ ...item, expiresAt: deadline });
  return expired ? <></> : <MaterialPreload item={{ ...item, expiresAt: deadline }} />;
};
const MaterialPreload = ({ item }: Readonly<{ item: Item }>): JSX.Element => {
  useAtomMount(useMaterialQuery(item));
  return <></>;
};
const RetainedMaterial = ({
  item,
}: Readonly<{
  item: Item;
}>): JSX.Element => {
  const query = useMaterialQuery(item);
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (reviewHasExpired(item)) return <ExpiredOriginal />;
  const unavailable =
    state._tag === "Failure" ? (
      <p className="text-sm text-muted-foreground">No pudimos cargar el original.</p>
    ) : (
      <PendingRead label="Cargando original" />
    );
  return (
    <details open data-review="original">
      <summary>
        Material original
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} aria-hidden="true" />
      </summary>
      <div data-review="original-body">
        {state._tag === "Ready" ? (
          <MaterialBody material={state.value.data} searchable={item.source === "email"} />
        ) : (
          unavailable
        )}
        {state._tag === "Failure" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!reviewHasExpired(item)) refresh();
            }}
          >
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
const MaterialBody = ({
  material,
  searchable,
}: Readonly<{
  material: Material;
  searchable: boolean;
}>): JSX.Element => {
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
      {searchable ? (
        <SearchableOriginal text={material.text} />
      ) : (
        <OriginalText text={material.text} />
      )}
      {material.truncated ? (
        <p className="mt-3 text-sm text-muted-foreground">Vista previa recortada.</p>
      ) : null}
    </>
  );
};

const OriginalText = ({ text }: Readonly<{ text: string }>): JSX.Element => (
  <pre className="max-h-[45svh] lg:max-h-[calc(100dvh-29rem)] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-7 [overflow-wrap:anywhere]">
    {text}
  </pre>
);

const SearchableOriginal = ({ text }: Readonly<{ text: string }>): JSX.Element => {
  const [search, setSearch] = useState("");
  const help = useId();
  const query = search.trim().toLocaleLowerCase("es-CO");
  const matches = text
    .split(/\r?\n/u)
    .filter((line) => line.toLocaleLowerCase("es-CO").includes(query));
  return (
    <div data-review="original-search">
      <Input
        aria-label="Buscar en este original"
        aria-describedby={help}
        placeholder="Buscar en este original"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p id={help}>Busca solo en el texto cargado de este original.</p>
      {query === "" ? (
        <OriginalText text={text} />
      ) : (
        <>
          <output>
            {matches.length === 0
              ? "Sin coincidencias en este original."
              : `${matches.length} ${matches.length === 1 ? "línea" : "líneas"} con coincidencias en este original.`}
          </output>
          {matches.length > 0 ? <OriginalText text={matches.join("\n")} /> : null}
        </>
      )}
    </div>
  );
};
