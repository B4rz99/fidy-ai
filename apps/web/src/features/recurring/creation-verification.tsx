import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { focusCreation } from "./creation-focus";

export const VerificationPending = ({
  waiting,
  refresh,
  focus,
}: Readonly<{ waiting: boolean; refresh: () => void; focus: boolean }>): JSX.Element => (
  <div className="grid gap-3" aria-live="polite">
    <p tabIndex={-1} ref={focus ? focusCreation : undefined}>
      El recurrente se guardó. Falta verificar si la transacción completa la primera ocurrencia.
    </p>
    <Button variant="outline" disabled={waiting} onClick={refresh}>
      Verificar vínculo
    </Button>
  </div>
);
