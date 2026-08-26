import type { FormEvent, JSX } from "react";
import { useState } from "react";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { DashboardDropTarget } from "./drag-data";
import type { DashboardCatalogEntry, DashboardGesture } from "./editor-model";
import type { DashboardWidget } from "./presentation";

export type PlacementChoice = Readonly<{ label: string; target: DashboardDropTarget }>;

type EditorAction = Readonly<{
  disabled: boolean;
  onGesture: (gesture: DashboardGesture) => void;
}>;

const PlacementSelect = ({
  choices,
  id,
  onChange,
  value,
}: Readonly<{
  choices: ReadonlyArray<PlacementChoice>;
  id: string;
  onChange: (index: number) => void;
  value: number;
}>): JSX.Element => (
  <select
    className="h-9 max-w-full rounded-md border bg-background px-2 text-sm"
    id={id}
    onChange={(event) => onChange(Number(event.currentTarget.value))}
    value={value}
  >
    {choices.map((choice, index) => (
      <option key={`${choice.label}:${index}`} value={index}>
        {choice.label}
      </option>
    ))}
  </select>
);

const WidgetTitleForm = ({
  disabled,
  fieldId,
  label,
  nextTitle,
  setNextTitle,
  submitTitle,
}: Readonly<{
  disabled: boolean;
  fieldId: string;
  label: string;
  nextTitle: string;
  setNextTitle: (title: string) => void;
  submitTitle: (event: FormEvent<HTMLFormElement>) => void;
}>): JSX.Element => (
  <form className="flex flex-wrap items-end gap-2" onSubmit={submitTitle}>
    <div className="grid min-w-44 flex-1 gap-1">
      <Label htmlFor={fieldId}>Título de {label}</Label>
      <Input
        disabled={disabled}
        id={fieldId}
        maxLength={80}
        onChange={(event) => setNextTitle(event.currentTarget.value)}
        value={nextTitle}
      />
    </div>
    <Button disabled={disabled} size="sm" type="submit" variant="outline">
      Guardar título de {label}
    </Button>
  </form>
);

const WidgetPlacementForm = ({
  choices,
  disabled,
  label,
  onRemove,
  placementId,
  placementIndex,
  setPlacementIndex,
  submitMove,
}: Readonly<{
  choices: ReadonlyArray<PlacementChoice>;
  disabled: boolean;
  label: string;
  onRemove: () => void;
  placementId: string;
  placementIndex: number;
  setPlacementIndex: (index: number) => void;
  submitMove: (event: FormEvent<HTMLFormElement>) => void;
}>): JSX.Element => (
  <form className="flex flex-wrap items-end gap-2" onSubmit={submitMove}>
    <div className="grid min-w-44 flex-1 gap-1">
      <Label htmlFor={placementId}>Mover {label}</Label>
      <PlacementSelect
        choices={choices}
        id={placementId}
        onChange={setPlacementIndex}
        value={placementIndex}
      />
    </div>
    <Button disabled={disabled || choices.length === 0} size="sm" type="submit">
      Mover Widget
    </Button>
    <Button disabled={disabled} onClick={onRemove} size="sm" type="button" variant="destructive">
      Eliminar {label}
    </Button>
  </form>
);

/** Deterministic non-drag controls for one existing Widget. */
export const DashboardWidgetControls = ({
  choices,
  disabled,
  label,
  onGesture,
  widget,
}: EditorAction &
  Readonly<{
    choices: ReadonlyArray<PlacementChoice>;
    label: string;
    widget: DashboardWidget;
  }>): JSX.Element => {
  const [nextTitle, setNextTitle] = useState(label);
  const [placementIndex, setPlacementIndex] = useState(0);
  const submitTitle = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onGesture({ kind: "retitle-widget", widget, title: nextTitle });
  };
  const submitMove = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const choice = choices[placementIndex];
    if (choice !== undefined) {
      onGesture({ kind: "move-widget", widgetId: widget.id, target: choice.target });
    }
  };
  const fieldId = `widget-title-${widget.id}`;
  const placementId = `widget-placement-${widget.id}`;
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" aria-label={`Editar ${label}`}>
      <WidgetTitleForm
        disabled={disabled}
        fieldId={fieldId}
        label={label}
        nextTitle={nextTitle}
        setNextTitle={setNextTitle}
        submitTitle={submitTitle}
      />
      <WidgetPlacementForm
        choices={choices}
        disabled={disabled}
        label={label}
        onRemove={() => onGesture({ kind: "remove-widget", widgetId: widget.id })}
        placementId={placementId}
        placementIndex={placementIndex}
        setPlacementIndex={setPlacementIndex}
        submitMove={submitMove}
      />
    </div>
  );
};

const CatalogEntrySelect = ({
  catalog,
  catalogIndex,
  setCatalogIndex,
}: Readonly<{
  catalog: ReadonlyArray<DashboardCatalogEntry>;
  catalogIndex: number;
  setCatalogIndex: (index: number) => void;
}>): JSX.Element => (
  <div className="grid gap-1.5">
    <Label htmlFor="dashboard-catalog-widget">Añadir Widget del catálogo</Label>
    <select
      className="h-9 rounded-md border bg-background px-2 text-sm"
      id="dashboard-catalog-widget"
      onChange={(event) => setCatalogIndex(Number(event.currentTarget.value))}
      value={catalogIndex}
    >
      {catalog.map((entry, index) => (
        <option key={entry.id} value={index}>
          {entry.name}
        </option>
      ))}
    </select>
  </div>
);

/** Deterministic catalog addition controls shared with the drag source list. */
export const DashboardCatalogControls = ({
  catalog,
  choices,
  disabled,
  makeWidgetId,
  onGesture,
}: EditorAction &
  Readonly<{
    catalog: ReadonlyArray<DashboardCatalogEntry>;
    choices: ReadonlyArray<PlacementChoice>;
    makeWidgetId: () => Extract<
      DashboardGesture,
      { readonly kind: "add-catalog-widget" }
    >["newWidgetId"];
  }>): JSX.Element => {
  const [catalogIndex, setCatalogIndex] = useState(0);
  const [placementIndex, setPlacementIndex] = useState(0);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const entry = catalog[catalogIndex];
    const choice = choices[placementIndex];
    if (entry !== undefined && choice !== undefined) {
      onGesture({
        kind: "add-catalog-widget",
        entry,
        newWidgetId: makeWidgetId(),
        target: choice.target,
      });
    }
  };
  return (
    <form
      className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={submit}
    >
      <CatalogEntrySelect
        catalog={catalog}
        catalogIndex={catalogIndex}
        setCatalogIndex={setCatalogIndex}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="dashboard-catalog-placement">Ubicación del nuevo Widget</Label>
        <PlacementSelect
          choices={choices}
          id="dashboard-catalog-placement"
          onChange={setPlacementIndex}
          value={placementIndex}
        />
      </div>
      <Button disabled={disabled || catalog.length === 0} type="submit">
        Añadir Widget
      </Button>
    </form>
  );
};

type RegionRatio = Extract<DashboardGesture, { readonly kind: "resize-region" }>["ratio"];

const defaultRegionShareIndex = 2;
const regionShareChoices: ReadonlyArray<Readonly<{ label: string; ratio: RegionRatio }>> = [
  { label: "25 %", ratio: "one-quarter" },
  { label: "33⅓ %", ratio: "one-third" },
  { label: "50 %", ratio: "one-half" },
  { label: "66⅔ %", ratio: "two-thirds" },
  { label: "75 %", ratio: "three-quarters" },
];

/** Changes one exact recursive region's parent share. */
export const DashboardRegionControls = ({
  disabled,
  label,
  onGesture,
  widgetIds,
}: EditorAction &
  Readonly<{
    label: string;
    widgetIds: Extract<DashboardGesture, { readonly kind: "resize-region" }>["widgetIds"];
  }>): JSX.Element => {
  const [shareIndex, setShareIndex] = useState(defaultRegionShareIndex);
  const selectedShare =
    regionShareChoices[shareIndex] ?? regionShareChoices[defaultRegionShareIndex];
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border bg-background/90 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        onGesture({
          kind: "resize-region",
          widgetIds,
          ratio: selectedShare?.ratio ?? "one-half",
        });
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor={`region-share-${widgetIds.join("-")}`}>Proporción de región {label}</Label>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          id={`region-share-${widgetIds.join("-")}`}
          onChange={(event) => setShareIndex(event.currentTarget.selectedIndex)}
          value={shareIndex}
        >
          {regionShareChoices.map((choice, index) => (
            <option key={choice.ratio} value={index}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      <Button disabled={disabled} size="sm" type="submit" variant="outline">
        Aplicar proporción
      </Button>
    </form>
  );
};
