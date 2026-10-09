import { DateTime, Option } from "effect";
import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/ui/components/input";

/** Keeps the native date picker and keyboard editor while presenting an unambiguous Spanish date. */
export const TransactionDateField = ({
  id,
  value,
  onChange,
  required,
}: Readonly<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
}>): JSX.Element => {
  const label = DateTime.make(`${value}T00:00:00Z`).pipe(
    Option.map((date) =>
      new Intl.DateTimeFormat("es-CO", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date.epochMilliseconds)
    ),
    Option.getOrElse(() => "Selecciona una fecha")
  );
  return (
    <div className="transaction-date-field">
      <Input
        id={id}
        required={required}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span aria-hidden="true">
        <HugeiconsIcon icon={Calendar03Icon} size={20} strokeWidth={1.5} />
        {label}
      </span>
    </div>
  );
};
