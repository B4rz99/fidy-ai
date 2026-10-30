import { reviewItemQuery } from "./query";
import { workspaceCategoriesQuery } from "@/transport/workspace-query";
import { ReviewDraftFooter, ReviewNotice } from "@/ui/components/review-workspace";
import { useReviewExpired } from "./expiry";
import type { ReviewDecisions, ReviewEditorState, ReviewWorkspaceQuery } from "./decisions";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  File01Icon,
  Image01Icon,
  InformationCircleIcon,
  Loading03Icon,
  Mail01Icon,
  PauseCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/ui/components/badge";
import { reviewExpiry, reviewReason, reviewTitle } from "./presentation";
import { type JSX, type ReactNode, useCallback, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { ReviewFields } from "./fields";
import { OriginalMaterial, ReviewMaterialPreload } from "./original";
import { type Category, type Detail, type Draft, type Item, deadline, sources } from "./model";

type Props = Readonly<{
  item: Item;
  decisions: ReviewDecisions;
  disabled: boolean;
  workspaceQuery: ReviewWorkspaceQuery;
}>;
export const ReviewEditor = (props: Props): JSX.Element => {
  const expired = useReviewExpired(props.item);
  return expired ? (
    <ExpiredReviewItem item={props.item} />
  ) : (
    <>
      <ReviewMaterialPreload item={props.item} />
      <ReviewItemEditor {...props} />
    </>
  );
};
const ExpiredReviewItem = ({
  item,
}: Readonly<{
  item: Item;
}>): JSX.Element => (
  <section data-review="expired">
    <ReviewItemHeading item={item} />
    <div data-review="history" data-status={item.status}>
      <HugeiconsIcon
        icon={item.status === "created" ? CheckmarkCircle02Icon : Clock01Icon}
        aria-hidden="true"
      />
      <h2>{item.status === "created" ? "Transacción creada" : "Este elemento venció"}</h2>
      <p>
        {item.status === "created"
          ? "La transacción sigue guardada. El material original venció."
          : "El original venció. Envía el material de nuevo para revisarlo."}
      </p>
    </div>
  </section>
);
const ReviewItemEditor = ({ item, decisions, disabled, workspaceQuery }: Props): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    reviewItemQuery({
      client: apiClient,
      workspace: workspaceQuery,
      id: item.id,
    })
  );
  const [categoryQuery] = useState(() => workspaceCategoriesQuery(apiClient).view);
  const detail = useAtomValue(query).pipe(presentCanonicalQuery);
  const categories = useAtomValue(categoryQuery).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const refreshCategories = useAtomRefresh(categoryQuery);
  const recover = (): void => {
    if (detail._tag === "Ready") decisions.recoverItem(detail.value.data);
    else refresh();
    refreshCategories();
  };
  if (detail._tag === "Initial" || categories._tag === "Initial") {
    return <ReviewItemUnavailable item={item} recover={recover} loading />;
  }
  if (detail._tag !== "Ready" || categories._tag !== "Ready") {
    return <ReviewItemUnavailable item={item} recover={recover} loading={false} />;
  }
  if (decisions.editor(detail.value.data).recovering) {
    return (
      <ReviewItemFrame item={item}>
        <RecoveringReviewItem recover={recover} />
      </ReviewItemFrame>
    );
  }
  return (
    <ReviewItemFrame item={detail.value.data.item}>
      {[detail, categories].some((state) => Option.isSome<unknown>(state.refreshFailure)) ? (
        <ReviewItemFailure recover={recover} />
      ) : null}
      <ReadyEditor
        detail={detail.value.data}
        decisions={decisions}
        disabled={[
          disabled,
          ...[detail, categories].map(
            (state) => state.waiting || Option.isSome(state.refreshFailure)
          ),
        ].some(Boolean)}
        categories={categories.value.data}
        recover={recover}
      />
    </ReviewItemFrame>
  );
};
const ReviewItemUnavailable = ({
  item,
  recover,
  loading,
}: Readonly<{
  item: Item;
  recover: () => void;
  loading: boolean;
}>): JSX.Element => (
  <ReviewItemFrame item={item}>
    {loading ? (
      <output data-review="detail-loading">
        <HugeiconsIcon icon={Loading03Icon} aria-hidden="true" />
        Cargando elemento…
      </output>
    ) : (
      <ReviewItemFailure recover={recover} />
    )}
  </ReviewItemFrame>
);
const ReviewItemFrame = ({
  item,
  children,
}: Readonly<{
  item: Item;
  children: ReactNode;
}>): JSX.Element => (
  <section data-review="detail">
    <ReviewItemHeading item={item} />
    {children}
  </section>
);
const RecoveringReviewItem = ({
  recover,
}: Readonly<{
  recover: () => void;
}>): JSX.Element => (
  <output className="block p-5">
    <p>Actualizando la versión guardada…</p>
    <Button variant="outline" onClick={recover}>
      Reintentar actualización
    </Button>
  </output>
);
const ReviewItemFailure = ({
  recover,
}: Readonly<{
  recover: () => void;
}>): JSX.Element => (
  <ReviewNotice text="No pudimos cargar todos los datos del elemento." error>
    <Button variant="outline" onClick={recover}>
      Reintentar
    </Button>
  </ReviewNotice>
);
const ReadyEditor = ({
  detail,
  categories,
  recover,
  decisions,
  disabled,
}: Readonly<{
  detail: Detail;
  decisions: ReviewDecisions;
  disabled: boolean;
  categories: ReadonlyArray<Category>;
  recover: () => void;
}>): JSX.Element => {
  const change = useCallback(
    (draft: Draft) => decisions.change(detail, draft),
    [decisions, detail]
  );
  const editor = decisions.editor(detail);
  const act = (kind: "Create" | "Skip"): void => decisions.decide(detail, kind);
  const locked = editor.locked || disabled;
  if (editor.detail.item.status !== "pending") {
    return <HistoryDetail detail={editor.detail} />;
  }
  const failed = editor.feedback === "uncertain" || editor.feedback === "failed";
  return (
    <>
      <div data-review="columns">
        <div className="min-w-0">
          <OriginalMaterial item={detail.item} />
        </div>
        <div data-review="form">
          <h2 className="sr-only">Completa la transacción</h2>
          <ReviewEditorNotice
            feedback={editor.feedback}
            creationRequired={!editor.canCreate}
            reason={reviewReason(detail.item)}
            recover={recover}
          />
          <ReviewFields
            draft={editor.draft}
            change={change}
            locked={locked}
            categories={categories}
            timeZone={detail.item.timeZone}
          />
        </div>
      </div>
      <ReviewDraftFooter
        feedback={
          <>
            <HugeiconsIcon icon={failed ? InformationCircleIcon : Tick02Icon} aria-hidden="true" />
            <output>{failed ? "Revisión necesaria" : feedbackCopy[editor.feedback]}</output>
          </>
        }
        actions={<ReviewEditorActions editor={editor} locked={locked} act={act} />}
      />
    </>
  );
};
const ReviewEditorActions = ({
  editor,
  locked,
  act,
}: Readonly<{
  editor: ReviewEditorState;
  locked: boolean;
  act: (kind: "Create" | "Skip") => void;
}>): JSX.Element => (
  <>
    <Button variant="ghost" onClick={() => act("Skip")} disabled={locked}>
      Omitir
    </Button>
    <Button onClick={() => act("Create")} disabled={locked || !editor.canCreate}>
      Confirmar
    </Button>
  </>
);
const feedbackCopy = {
  saved: "Borrador guardado",
  saving: "Guardando borrador…",
  unsaved: "Cambios pendientes de guardar…",
  failed: "El elemento cambió. Actualiza para revisar la versión guardada.",
  uncertain: "No pudimos confirmar el guardado. Actualiza antes de continuar.",
} as const;
const historyTitles = {
  pending: "Por revisar",
  skipped: "Elemento omitido",
  created: "Transacción creada",
  expired: "Este elemento venció",
};
const HistoryDetail = ({
  detail,
}: Readonly<{
  detail: Detail;
}>): JSX.Element => (
  <div data-review="columns">
    <OriginalMaterial item={detail.item} />
    <div data-review="history" data-status={detail.item.status}>
      <HugeiconsIcon
        icon={detail.item.status === "created" ? CheckmarkCircle02Icon : PauseCircleIcon}
        aria-hidden="true"
      />
      <h2 className="text-xl font-medium">{historyTitles[detail.item.status]}</h2>
      <p className="mt-3 text-sm text-muted-foreground">{historyDescription(detail.item)}</p>
    </div>
  </div>
);
const sourceIcons = { statement: File01Icon, media: Image01Icon, email: Mail01Icon };
const ReviewItemHeading = ({
  item,
}: Readonly<{
  item: Item;
}>): JSX.Element => (
  <header data-review="detail-heading">
    <div data-review="item-heading">
      <span data-review="source-icon" data-source={item.source}>
        <HugeiconsIcon icon={sourceIcons[item.source]} size={22} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <h2>{reviewTitle(item)}</h2>
        <p>{sources[item.source]}</p>
      </div>
    </div>
    <Badge variant="secondary" data-review="deadline" title={deadline(item)}>
      {reviewExpiry(item)}
    </Badge>
  </header>
);
const historyDescription = (item: Item): string => {
  if (item.status === "expired") return "Envía el material de nuevo para revisarlo.";
  if (item.status === "created") {
    return "La transacción ya está guardada.";
  }
  return "Selecciona este elemento y pulsa Restaurar para volver a editarlo. Su vencimiento original se conserva.";
};
const ReviewEditorNotice = ({
  feedback,
  creationRequired,
  reason,
  recover,
}: Readonly<{
  feedback: keyof typeof feedbackCopy;
  creationRequired: boolean;
  reason: string;
  recover: () => void;
}>): JSX.Element => {
  if (feedback === "failed" || feedback === "uncertain") {
    return (
      <ReviewNotice text={feedbackCopy[feedback]} error>
        <Button variant="outline" onClick={recover}>
          Actualizar elemento
        </Button>
      </ReviewNotice>
    );
  }
  if (creationRequired) {
    return (
      <ReviewNotice text={reason} error={false}>
        {null}
      </ReviewNotice>
    );
  }
  return <></>;
};
