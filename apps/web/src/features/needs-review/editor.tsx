import { RetryExtraction } from "./retry";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { ReviewFields } from "./fields";
import { useReviewEditor } from "./editor-controller";
import { OriginalMaterial } from "./original";
import { type Category, type Detail, type Item, deadline } from "./model";

type Props = Readonly<{
  item: Item;
  finished: (items: ReadonlyArray<Detail>, skipped: boolean) => void;
}>;
export const ReviewEditor = ({ item, finished }: Props): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    apiClient.query("ingestion", "getReviewItem", { params: { id: item.id } })
  );
  const [categoryQuery] = useState(() => apiClient.query("categories", "listCategories", {}));
  const detail = useAtomValue(query).pipe(presentCanonicalQuery);
  const categories = useAtomValue(categoryQuery).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const [recovery, setRecovery] = useState(0);
  const [previous, setPrevious] = useState<Option.Option<Detail>>(Option.none);
  const recover = (): void => {
    if (detail._tag === "Ready") setPrevious(Option.some(detail.value.data));
    refresh();
    setRecovery((value) => value + 1);
  };
  if (detail._tag !== "Ready" || categories._tag !== "Ready") {
    return (
      <div className="p-5">
        <p>No pudimos cargar todos los datos del elemento.</p>
        <Button variant="outline" onClick={recover}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (Option.isSome(previous) && previous.value === detail.value.data) {
    return (
      <output className="block p-5">
        <p>Actualizando la versión guardada…</p>
        <Button variant="outline" onClick={recover}>
          Reintentar actualización
        </Button>
      </output>
    );
  }
  return (
    <div className="grid min-w-0 xl:grid-cols-2">
      <OriginalMaterial key={item.id} item={detail.value.data.item} />
      <ReadyEditor
        key={`${item.id}:${recovery}`}
        detail={detail.value.data}
        categories={categories.value.data}
        finished={finished}
        recover={recover}
      />
    </div>
  );
};
const ReadyEditor = ({
  detail,
  categories,
  finished,
  recover,
}: Readonly<{
  detail: Detail;
  categories: ReadonlyArray<Category>;
  finished: Props["finished"];
  recover: () => void;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const editor = useReviewEditor({ apiClient, detail, finished });
  if (detail.item.status !== "pending") {
    return <HistoryDetail detail={detail} />;
  }
  return (
    <div className="min-w-0 p-5">
      <h2 className="text-xl font-medium">Completa la transacción</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Revisa los datos antes de crearla. Disponible hasta {deadline(detail.item)}. Los datos que
        completes se registrarán como proporcionados por ti.
      </p>
      <output className="my-4 text-sm text-muted-foreground">
        {feedbackCopy[editor.feedback]}
      </output>
      <RetryExtraction item={detail.item} suggested={editor.suggested} disabled={editor.locked} />
      <ReviewFields
        draft={editor.draft}
        change={editor.change}
        locked={editor.locked}
        categories={categories}
        timeZone={detail.item.timeZone}
      />
      {editor.feedback === "uncertain" || editor.feedback === "failed" ? (
        <Button className="mt-4" variant="outline" onClick={recover}>
          Actualizar elemento
        </Button>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          onClick={() => editor.act("Create")}
          disabled={editor.locked || Option.isNone(editor.creation)}
        >
          Crear transacción
        </Button>
        <Button variant="outline" onClick={() => editor.act("Skip")} disabled={editor.locked}>
          Omitir
        </Button>
      </div>
    </div>
  );
};
const feedbackCopy = {
  saved: "Borrador guardado",
  saving: "Guardando borrador…",
  unsaved: "Cambios pendientes de guardar…",
  failed: "El elemento cambió. Actualiza para revisar la versión guardada.",
  uncertain: "No pudimos confirmar el guardado. Actualiza antes de continuar.",
} as const;

const HistoryDetail = ({ detail }: Readonly<{ detail: Detail }>): JSX.Element => {
  const expired = detail.item.status === "expired";
  return (
    <div className="p-5">
      <h2 className="text-xl font-medium">
        {expired ? "Este elemento venció" : "Elemento en el historial"}
      </h2>
      <p className="mt-3 text-sm text-muted-foreground">
        {expired
          ? "Envía el material de nuevo para revisarlo."
          : "Restaura un elemento omitido para volver a editarlo."}
      </p>
      {Option.isSome(detail.item.transactionId) ? (
        <a
          className="mt-4 inline-block underline"
          href={`/app/needs-review/transactions/${detail.item.transactionId.value}`}
        >
          Ver transacción
        </a>
      ) : null}
    </div>
  );
};
