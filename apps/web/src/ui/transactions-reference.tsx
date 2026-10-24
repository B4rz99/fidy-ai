import { type JSX, useState } from "react";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { Button } from "@/ui/components/button";
import {
  TransactionContextPanel,
  TransactionSurface,
  TransactionTypeToggle,
} from "@/ui/components/transactions";

export const TransactionsReference = (): JSX.Element => {
  const [type, onType] = useState<"inflow" | "outflow">("outflow");
  return (
    <section aria-label="Composición aprobada de transacciones">
      <TransactionSurface panelOpen={false}>
        <header data-transaction-slot="transaction-page-header">
          <h1>Transacciones</h1>
          <Button>+ Registrar</Button>
        </header>
        <TransactionContextPanel
          title="Campos de ejemplo"
          identity="example"
          active={false}
          locked={false}
          onClose={() => {}}
        >
          <h2>Registrar transacción</h2>
          <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
            <TransactionTypeToggle value={type} onChange={onType} />
            <Label htmlFor="reference-transaction-amount">Monto · COP</Label>
            <Input id="reference-transaction-amount" inputMode="decimal" placeholder="0,00" />
            <Label htmlFor="reference-transaction-notes">Notas (opcional)</Label>
            <textarea
              id="reference-transaction-notes"
              maxLength={500}
              placeholder="Añadir una nota"
            />
            <div data-transaction-slot="transaction-form-actions">
              <Button variant="outline">Cancelar</Button>
              <Button>Guardar</Button>
            </div>
          </form>
          <Button variant="outline" data-transaction-slot="transaction-danger">
            Eliminar
          </Button>
        </TransactionContextPanel>
      </TransactionSurface>
    </section>
  );
};
