import { Dialog } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { Button } from "./button";

export const DashboardBudgetDialog = ({
  children,
  open,
  onClose,
}: Readonly<{
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}>): JSX.Element => (
  <Dialog.Root
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/10" />
      <Dialog.Popup className="signed-in-theme fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-lg">
        <div className="grid gap-2 pr-10">
          <Dialog.Title className="font-heading text-xl font-semibold">
            Configurar presupuesto
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            Elige el presupuesto que quieres ver en este widget.
          </Dialog.Description>
        </div>
        <Dialog.Close
          render={
            <Button type="button" variant="ghost" size="icon" className="absolute top-3 right-3" />
          }
          aria-label="Cerrar configuración"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.5} aria-hidden="true" />
        </Dialog.Close>
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
