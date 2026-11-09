import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { type Item, type Workspace, sources } from "./model";
import { Option } from "effect";
import { type PageContexts, sourceReference } from "./source-context";
import { reviewAmount, reviewTitle } from "./presentation";
import { SelectionSummary } from "@/ui/components/selection-summary";
import type { InboxControl } from "./inbox-controller";

const selectedCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "seleccionado" : "seleccionados"}`;

type ToolbarProps = Readonly<{
  sourceId: string;
  view: Workspace;
  visibleItems: ReadonlyArray<Item>;
  contexts: PageContexts;
  page: number;
  control: InboxControl;
}>;
const ReviewSelection = ({
  view,
  visibleItems,
  contexts,
  page,
  control,
  sourceId,
}: ToolbarProps): JSX.Element => {
  const checked = new Set(control.checked);
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  return (
    <SelectionSummary
      clearFocusId={sourceId}
      label={selectedCountLabel(control.checked.length)}
      disabled={control.locked}
      onClear={control.clearChecked}
      onRemove={(id) => {
        const item = view.items.find((item) => item.id === id);
        if (item !== undefined) control.toggle(item);
      }}
      items={view.items.flatMap((item, index) =>
        checked.has(item.id)
          ? [
              {
                id: item.id,
                label: `${sources[item.source]} ${sourceReference({ item, context: Option.fromUndefinedOr(contexts.get(item.id)), position: page + index + 1 })}`,
                description: `${reviewTitle(item)} · ${reviewAmount(item)}`,
                hidden: !visibleIds.has(item.id),
              },
            ]
          : []
      )}
    />
  );
};
const ReviewBulkAction = ({
  selected,
  control,
}: Readonly<{ selected: ReadonlyArray<Item>; control: InboxControl }>): JSX.Element => {
  const pending = selected.some((item) => item.status === "pending");
  const label = selectedCountLabel(control.checked.length);
  const unavailable = selected.length === 0 || selected.length !== control.checked.length;
  return (
    <Button
      variant="outline"
      disabled={control.locked || unavailable}
      onClick={() => control.bulk(!pending, selected)}
    >
      {pending ? `Omitir ${label}` : `Restaurar ${label}`}
    </Button>
  );
};
export const ReviewToolbar = ({ view, control, ...props }: ToolbarProps): JSX.Element => {
  if (control.checked.length === 0 && control.undoCount === 0 && control.feedback === "") {
    return <></>;
  }
  const checked = new Set(control.checked);
  const selected = view.items.filter((item) => checked.has(item.id));
  return (
    <div data-review="bulk">
      <ReviewSelection {...props} view={view} control={control} />
      <ReviewBulkAction selected={selected} control={control} />
      {control.undoCount > 0 ? (
        <Button variant="ghost" disabled={control.locked} onClick={control.undoSkip}>
          Deshacer omisión
        </Button>
      ) : null}
      {control.feedback !== "" ? (
        <p role="alert" className="text-sm">
          {control.feedback}
        </p>
      ) : null}
    </div>
  );
};
