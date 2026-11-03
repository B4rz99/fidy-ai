import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { DirectionIndicator } from "./icon-indicator";
import "./transaction-candidate.css";

export const TransactionCandidate = ({
  name,
  date,
  amount,
  notes,
  inflow,
  selected,
  disabled,
  onSelect,
}: Readonly<{
  name: string;
  date: string;
  amount: string;
  notes: string;
  inflow: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}>): JSX.Element => (
  <button
    type="button"
    data-transaction-candidate="row"
    aria-pressed={selected}
    disabled={disabled}
    onClick={onSelect}
  >
    <span className="sr-only">Revisar </span>
    <DirectionIndicator inflow={inflow} />
    <span data-transaction-candidate="identity">
      <strong>{name}</strong>
      <span>
        {date}
        {notes === "" ? "" : ` · ${notes}`}
      </span>
    </span>
    <span data-transaction-candidate="money">
      <strong>
        {inflow ? "+" : "−"}
        {amount}
      </strong>
      <span>
        {selected ? "Seleccionada" : "Revisar"}
        <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
    </span>
  </button>
);
