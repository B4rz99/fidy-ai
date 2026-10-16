import { Currency } from "@fidy/server/client";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { Option } from "effect";
import type { JSX } from "react";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import {
  type Category,
  type Draft,
  canonicalOccurrence,
  editDraft,
  localOccurrence,
} from "./model";

type Props = Readonly<{
  draft: Draft;
  change: (draft: Draft) => void;
  locked: boolean;
  categories: ReadonlyArray<Category>;
  timeZone: string;
}>;
export const ReviewFields = (props: Props): JSX.Element => (
  <div className="grid gap-6">
    <ReviewCounterparty {...props} />
    <div className="grid grid-cols-2 items-start gap-3">
      <div className="grid content-start gap-2.5">
        <Label htmlFor="review-amount">Valor</Label>
        <Input
          id="review-amount"
          inputMode="decimal"
          value={props.draft.amount}
          maxLength={120}
          disabled={props.locked}
          aria-invalid={props.draft.amount === ""}
          onChange={(event) =>
            props.change(
              editDraft({
                draft: props.draft,
                field: "money",
                value: { amount: event.target.value },
              })
            )
          }
        />
      </div>
      <div className="grid content-start gap-2.5">
        <Label htmlFor="review-currency">Moneda</Label>
        <SearchableChoiceDropdown
          id="review-currency"
          label="Moneda"
          value={Option.getOrElse(props.draft.currency, () => "")}
          options={Currency.literals.map((value) => ({ value, label: value }))}
          disabled={props.locked}
          width="full"
          onChange={(currency) =>
            props.change(editDraft({ draft: props.draft, field: "money", value: { currency } }))
          }
        />
        {Option.isNone(props.draft.currency) ? (
          <p className="text-xs text-muted-foreground">Confirma la moneda para continuar.</p>
        ) : null}
      </div>
    </div>
    <ReviewOccurrence {...props} />
    <ReviewDirection {...props} />
    <ReviewCategory {...props} />
  </div>
);
const ReviewCounterparty = (props: Props): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Label htmlFor="review-counterparty">Contraparte (opcional)</Label>
    <Input
      id="review-counterparty"
      value={props.draft.counterparty}
      maxLength={120}
      disabled={props.locked}
      onChange={(event) =>
        props.change(
          editDraft({
            draft: props.draft,
            field: "counterparty",
            value: { counterparty: event.target.value },
          })
        )
      }
    />
  </div>
);
const ReviewDirection = ({ draft, change, locked }: Props): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Label htmlFor="review-direction">
      Tipo de transacción{Option.isNone(draft.direction) ? " · Falta completar" : ""}
    </Label>
    <ChoiceDropdown
      id="review-direction"
      label="Tipo de transacción"
      value={Option.getOrElse(draft.direction, () => "")}
      triggerLabel={Option.some(
        Option.match(draft.direction, {
          onNone: () => "Selecciona el tipo",
          onSome: (value) => (value === "outflow" ? "Salida" : "Entrada"),
        })
      )}
      leading={null}
      width="full"
      disabled={locked}
      options={[
        { value: "outflow", label: "Salida" },
        { value: "inflow", label: "Entrada" },
      ]}
      onChange={(value) =>
        change(editDraft({ draft, field: "direction", value: { direction: value } }))
      }
    />
  </div>
);
const ReviewCategory = ({ draft, change, locked, categories }: Props): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Label htmlFor="review-category">Categoría</Label>
    <ChoiceDropdown
      id="review-category"
      label="Categoría"
      value={Option.getOrElse(draft.categoryId, () => "")}
      triggerLabel={Option.some(
        categories.find((category) => Option.contains(draft.categoryId, category.id))?.label ??
          "Asignar automáticamente"
      )}
      leading={null}
      width="full"
      disabled={locked}
      options={categories.map((category) => ({ value: category.id, label: category.label }))}
      onChange={(value) =>
        change(editDraft({ draft, field: "categoryId", value: { categoryId: value } }))
      }
    />
  </div>
);

const ReviewOccurrence = (props: Props): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Label htmlFor="review-date">
      Fecha y hora{" "}
      {props.draft.occurredAt === "" ? (
        <span className="rounded-md bg-warning/60 px-2 py-1 text-xs font-medium">
          Por confirmar
        </span>
      ) : null}
    </Label>
    <Input
      id="review-date"
      type="datetime-local"
      value={localOccurrence({ value: props.draft.occurredAt, timeZone: props.timeZone })}
      disabled={props.locked}
      aria-invalid={props.draft.occurredAt === ""}
      onChange={(event) =>
        props.change(
          editDraft({
            draft: props.draft,
            field: "occurredAt",
            value: {
              occurredAt: canonicalOccurrence({
                value: event.target.value,
                timeZone: props.timeZone,
              }),
            },
          })
        )
      }
    />
    <p className="text-xs text-muted-foreground">Hora de {props.timeZone}.</p>
  </div>
);
