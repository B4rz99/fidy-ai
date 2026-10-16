import { useReviewExpired } from "./expiry";
import { RefreshButton } from "@/ui/components/refresh-button";
import type { DraftBarrier } from "./draft-barrier";
import { RetryExtraction } from "./retry";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, Image01Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/ui/components/badge";
import { reviewExpiry, reviewReason, reviewTitle } from "./presentation";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { ReviewFields } from "./fields";
import { useReviewEditor } from "./editor-controller";
import { OriginalMaterial } from "./original";
import { type Category, type Detail, type Item, deadline, sources } from "./model";

type Props = Readonly<{
  item: Item;
  barrier: DraftBarrier;
  disabled: boolean;
  finished: (items: ReadonlyArray<Detail>, skipped: boolean) => void;
}>;
export const ReviewEditor = (props: Props): JSX.Element => {
  const expired = useReviewExpired(props.item);
  return expired ? <ExpiredReviewItem item={props.item} /> : <ReviewItemEditor {...props} />;
};
const ExpiredReviewItem = ({ item }: Readonly<{ item: Item }>): JSX.Element => (
  <div className="p-5">
    <h2 className="text-xl font-semibold">
      {item.status === "created" ? "Transacción creada" : "Este elemento venció"}
    </h2>
    <p className="mt-3 text-sm text-muted-foreground">
      El original venció. Envía el material de nuevo para revisarlo.
    </p>
    {item.status === "created" ? (
      <a
        className="mt-4 inline-block underline"
        href={`/app/needs-review/transactions/${item.transactionId}`}
      >
        Ver transacción
      </a>
    ) : null}
  </div>
);
const ReviewItemEditor = ({ item, finished, barrier, disabled }: Props): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    apiClient.query("ingestion", "getReviewItem", {
      params: { id: item.id },
      reactivityKeys: ["ingestion-review"],
    })
  );
  const [categoryQuery] = useState(() => apiClient.query("categories", "listCategories", {}));
  const detail = useAtomValue(query).pipe(presentCanonicalQuery);
  const categories = useAtomValue(categoryQuery).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const refreshCategories = useAtomRefresh(categoryQuery);
  const [recovery, setRecovery] = useState(0);
  const [previous, setPrevious] = useState<Option.Option<Detail>>(Option.none);
  const recover = (): void => {
    if (detail._tag === "Ready") setPrevious(Option.some(detail.value.data));
    barrier.delete(item.id);
    refresh();
    refreshCategories();
    setRecovery((value) => value + 1);
  };
  if (detail._tag === "Initial" || categories._tag === "Initial") {
    return <p className="p-6 text-sm text-muted-foreground">Cargando elemento…</p>;
  }
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
    <section className="flex min-h-0 min-w-0 flex-col p-5 lg:p-4">
      <ReviewItemHeading item={detail.value.data.item} />
      <ReadyEditor
        key={`${item.id}:${recovery}`}
        detail={detail.value.data}
        barrier={barrier}
        disabled={disabled}
        categories={categories.value.data}
        finished={finished}
        recover={recover}
      />
    </section>
  );
};
const ReadyEditor = ({
  detail,
  categories,
  finished,
  recover,
  barrier,
  disabled,
}: Readonly<{
  detail: Detail;
  barrier: DraftBarrier;
  disabled: boolean;
  categories: ReadonlyArray<Category>;
  finished: Props["finished"];
  recover: () => void;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const editor = useReviewEditor({ apiClient, detail, finished, barrier });
  const locked = editor.locked || disabled;
  if (detail.item.status !== "pending") {
    return <HistoryDetail detail={detail} />;
  }
  return (
    <>
      <div className="mt-4 grid min-h-0 min-w-0 flex-1 items-start gap-6 lg:overflow-auto xl:grid-cols-2">
        <div className="min-w-0">
          <OriginalMaterial item={detail.item} />
          <RetryExtraction item={detail.item} suggested={editor.suggested} disabled={locked} />
        </div>
        <div className="min-w-0">
          <h2 className="sr-only">Completa la transacción</h2>
          <p className="mb-3 rounded-xl bg-warning/35 px-4 py-2 text-sm font-medium">
            {reviewReason(detail.item)}
          </p>
          <ReviewFields
            draft={editor.draft}
            change={editor.change}
            locked={locked}
            categories={categories}
            timeZone={detail.item.timeZone}
          />
          <EditorFeedback feedback={editor.feedback} recover={recover} />
        </div>
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-4 border-t pt-3 pr-16">
        <Button variant="ghost" onClick={() => editor.act("Skip")} disabled={locked}>
          Omitir
        </Button>
        <Button
          onClick={() => editor.act("Create")}
          disabled={locked || Option.isNone(editor.creation)}
        >
          Crear transacción
        </Button>
      </div>
    </>
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
  const titles = {
    pending: "Por revisar",
    skipped: "Elemento omitido",
    created: "Transacción creada",
    expired: "Este elemento venció",
  };
  return (
    <div className="mt-4 grid min-h-0 min-w-0 flex-1 items-start gap-6 lg:overflow-auto xl:grid-cols-2">
      <OriginalMaterial item={detail.item} />
      <div className="rounded-2xl border p-6">
        <h2 className="text-xl font-medium">{titles[detail.item.status]}</h2>
        <p className="mt-3 text-sm text-muted-foreground">{historyDescription(detail.item)}</p>
        {detail.item.status === "created" ? (
          <a
            className="mt-4 inline-block underline"
            href={`/app/needs-review/transactions/${detail.item.transactionId}`}
          >
            Ver transacción
          </a>
        ) : null}
      </div>
    </div>
  );
};

const sourceIcons = { statement: File01Icon, media: Image01Icon, email: Mail01Icon };
const ReviewItemHeading = ({ item }: Readonly<{ item: Item }>): JSX.Element => (
  <header className="flex shrink-0 flex-wrap items-start gap-3">
    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-information/60">
      <HugeiconsIcon icon={sourceIcons[item.source]} size={22} aria-hidden="true" />
    </span>
    <div className="min-w-0 flex-1">
      <h2 className="text-xl font-semibold tracking-tight">{reviewTitle(item)}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{sources[item.source]}</p>
    </div>
    <Badge variant="secondary" title={deadline(item)}>
      {reviewExpiry(item)}
    </Badge>
  </header>
);

const EditorFeedback = ({
  feedback,
  recover,
}: Readonly<{ feedback: keyof typeof feedbackCopy; recover: () => void }>): JSX.Element => (
  <>
    <output className="mt-2 block text-xs text-muted-foreground">{feedbackCopy[feedback]}</output>
    <p className="mt-1 text-xs text-muted-foreground">
      Los datos que completes se registrarán como proporcionados por ti.
    </p>
    {feedback === "uncertain" || feedback === "failed" ? (
      <RefreshButton
        className="mt-4"
        variant="outline"
        onClick={recover}
        label="Actualizar elemento"
      />
    ) : null}
  </>
);

const historyDescription = (item: Item): string => {
  if (item.status === "expired") return "Envía el material de nuevo para revisarlo.";
  if (item.status === "created") {
    return "La transacción ya está guardada. Puedes abrirla para consultar sus datos.";
  }
  return "Selecciona este elemento y pulsa Restaurar para volver a editarlo. Su vencimiento original se conserva.";
};
