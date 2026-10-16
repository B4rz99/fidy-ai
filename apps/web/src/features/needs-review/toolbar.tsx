import { RefreshButton } from "@/ui/components/refresh-button";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import type { Workspace } from "./model";
import type { InboxControl } from "./inbox-controller";

export const ReviewToolbar = ({
  view,
  control,
}: Readonly<{ view: Workspace; control: InboxControl }>): JSX.Element => {
  if (control.checked.length === 0 && control.undo.length === 0 && control.feedback === "") {
    return <></>;
  }
  const pending = view.items.some((item) => item.status === "pending");
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
      <span className="text-sm text-muted-foreground">
        {view.pendingCount} pendientes · {control.checked.length} seleccionados
      </span>
      <Button
        variant="outline"
        disabled={control.locked || control.checked.length === 0}
        onClick={() =>
          control.bulk(
            !pending,
            view.items.filter((item) => control.checked.includes(item.id))
          )
        }
      >
        {pending
          ? `Omitir ${control.checked.length} seleccionados`
          : `Restaurar ${control.checked.length} seleccionados`}
      </Button>
      <RefreshButton variant="ghost" onClick={control.recover} label="Actualizar" />
      {control.undo.length > 0 ? (
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
