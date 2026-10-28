import { RefreshButton } from "@/ui/components/refresh-button";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import type { Workspace } from "./model";
import type { InboxControl } from "./inbox-controller";

const selectedCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "seleccionado" : "seleccionados"}`;

export const ReviewToolbar = ({
  view,
  control,
}: Readonly<{ view: Workspace; control: InboxControl }>): JSX.Element => {
  if (control.checked.length === 0 && control.undoCount === 0 && control.feedback === "") {
    return <></>;
  }
  const checked = new Set(control.checked);
  const selectedLabel = selectedCountLabel(control.checked.length);
  const pending = view.items.some((item) => item.status === "pending");
  return (
    <div data-review="bulk">
      <span className="text-sm text-muted-foreground">{selectedLabel}</span>
      <Button
        variant="outline"
        disabled={control.locked || control.checked.length === 0}
        onClick={() =>
          control.bulk(
            !pending,
            view.items.filter((item) => checked.has(item.id))
          )
        }
      >
        {pending ? `Omitir ${selectedLabel}` : `Restaurar ${selectedLabel}`}
      </Button>
      <RefreshButton variant="ghost" onClick={control.recover} label="Actualizar" />
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
