import { browserSecureRandom } from "@/browser/crypto";
import { Effect, Option } from "effect";
import { type JSX, useState } from "react";
import { RecurringPlanId } from "@/transport/client";
import { DeferredDisclosure } from "@/ui/components/disclosure";
import { PlanForm } from "./plan-form";
import { TransactionPicker } from "./transactions";
import {
  type Category,
  type CreationReceipt,
  type PlanInput,
  type Save,
  planFromTransaction,
} from "./model";

type CreationDraft = Readonly<{
  initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
  seriesId: Option.Option<string>;
}>;
type Props = CreationDraft &
  Readonly<{
    categories: ReadonlyArray<Category>;
    disabled: boolean;
    save: Save;
    created: (receipt: CreationReceipt) => void;
  }>;
export const CreatePlan = (props: Props): JSX.Element => {
  const { initial, seriesId, categories, disabled, save, created } = props;
  const [draft, setDraft] = useState({ initial, transactionId: Option.none<string>() });
  const submit = (plan: PlanInput): void => {
    const id = RecurringPlanId.make(
      Effect.runSync(browserSecureRandom.uuidV4().pipe(Effect.orDie))
    );
    const source = draft.transactionId;
    save(
      {
        kind: "create",
        id,
        plan,
        ...(Option.isSome(seriesId) ? { seriesId: seriesId.value } : {}),
      },
      Option.isSome(source)
        ? (): void => created({ planId: id, date: plan.firstDate, transactionId: source.value })
        : undefined
    );
  };
  return (
    <>
      <div data-recurring-slot="create-source">
        <DeferredDisclosure title="Crear desde una transacción">
          <TransactionPicker
            disabled={disabled}
            timeZone={initial.timeZone}
            choose={(transaction) =>
              setDraft({
                initial: planFromTransaction({ transaction, timeZone: initial.timeZone }),
                transactionId: Option.some(transaction.id),
              })
            }
          />
        </DeferredDisclosure>
      </div>
      {Option.isSome(draft.transactionId) ? (
        <p className="text-sm text-muted-foreground">
          Seleccionar una transacción copia sus datos; no garantiza que complete la primera
          ocurrencia. Al guardar te mostraremos si quedó vinculada. Si solo quieres planear los
          próximos pagos o ingresos, elige una primera fecha futura.
        </p>
      ) : null}
      <PlanForm
        key={JSON.stringify(draft)}
        initial={draft.initial}
        categories={categories}
        disabled={disabled}
        onSubmit={submit}
      />
    </>
  );
};
