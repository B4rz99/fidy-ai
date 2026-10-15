import { Option, Schema } from "effect";
import { type JSX } from "react";
import { RecurringFilters } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { NativeSelect } from "@/ui/components/native-select";
import type { Category, Filters } from "./model";
import { frequencies, kinds, statuses } from "./model";

const FilterSelect = ({
  name,
  label,
  options,
  value,
}: Readonly<{
  name: string;
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
  value: Option.Option<string>;
}>): JSX.Element => (
  <NativeSelect
    name={name}
    aria-label={label}
    size="default"
    defaultValue={Option.getOrElse(value, () => "")}
  >
    <option value="">{label}</option>
    {options.map(([key, text]) => (
      <option key={key} value={key}>
        {text}
      </option>
    ))}
  </NativeSelect>
);
const parseFilters = (form: FormData): Option.Option<Filters> => {
  const raw = Object.fromEntries([...form].filter(([, value]) => value !== ""));
  return Schema.decodeOption(RecurringFilters)(raw);
};
type FilterProps = Readonly<{
  filters: Filters;
  categories: ReadonlyArray<Category>;
  apply: (filters: Filters) => void;
}>;
export const FiltersForm = ({ filters, categories, apply }: FilterProps): JSX.Element => (
  <details className="rounded-lg border p-3">
    <summary className="cursor-pointer text-sm font-medium">Filtros</summary>
    <form
      className="mt-3 flex flex-wrap gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseFilters(new FormData(event.currentTarget));
        if (Option.isSome(parsed)) apply(parsed.value);
      }}
    >
      <Input
        name="search"
        aria-label="Buscar recurrentes"
        placeholder="Buscar recurrentes"
        className="max-w-64"
        defaultValue={filters.search ?? ""}
      />
      <FilterSelect
        name="kind"
        label="Todos los tipos"
        options={kinds}
        value={Option.fromUndefinedOr(filters.kind)}
      />
      <FilterSelect
        name="frequency"
        label="Todas las frecuencias"
        options={frequencies}
        value={Option.fromUndefinedOr(filters.frequency)}
      />
      <FilterSelect
        name="status"
        label="Todos los estados"
        options={Object.entries(statuses)}
        value={Option.fromUndefinedOr(filters.status)}
      />
      <FilterSelect
        name="categoryId"
        label="Todas las categorías"
        options={categories.map((category) => [category.id, category.label])}
        value={Option.fromUndefinedOr(filters.categoryId)}
      />
      <Input
        name="currency"
        aria-label="Filtrar moneda"
        placeholder="Moneda, ej. COP"
        className="max-w-40"
        defaultValue={filters.currency ?? ""}
      />
      <Button type="submit">Aplicar filtros</Button>
      <Button variant="ghost" type="button" onClick={() => apply({})}>
        Limpiar
      </Button>
    </form>
  </details>
);
