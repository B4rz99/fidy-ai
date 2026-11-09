import { Dialog } from "@base-ui/react/dialog";
import type { JSX } from "react";
import { Button } from "./button";

export const SelectionScopeDialog = ({
  open,
  count,
  onKeep,
  returnFocusId,
  onDiscard,
}: Readonly<{
  open: boolean;
  count: number;
  onKeep: () => void;
  returnFocusId: string;
  onDiscard: () => void;
}>): JSX.Element => (
  <Dialog.Root
    open={open}
    onOpenChange={(next) => {
      if (!next) onKeep();
    }}
  >
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/10" />
      <Dialog.Popup
        finalFocus={() => document.getElementById(returnFocusId)}
        className="signed-in-theme fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100svh-2rem)] w-[calc(100%-2*var(--fidy-space-16))] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-xl border bg-popover p-[var(--fidy-space-24)] text-popover-foreground shadow-lg"
      >
        <Dialog.Title className="font-heading text-xl font-semibold">
          ¿Limpiar la selección para cambiar de vista?
        </Dialog.Title>
        <Dialog.Description>
          Al cambiar de vista se limpiará tu selección de {count} registros. Puedes conservarla y
          seguir en esta vista. No se modificará ningún registro.
        </Dialog.Description>
        <div className="flex flex-wrap gap-3">
          <Button contentLayout="wrap" onClick={onKeep}>
            Conservar selección
          </Button>
          <Button contentLayout="wrap" variant="outline" onClick={onDiscard}>
            Limpiar selección y continuar
          </Button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
