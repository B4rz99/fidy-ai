import { Option, Schema } from "effect";
import { type JSX, useState } from "react";
import { Currency, RecurringFilters } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { Input } from "@/ui/components/input";
import type { Category, Filters } from "./model";
import { frequencies, kinds, statuses } from "./model";

const searchLimit = 120;

type FilterProps = Readonly<{
  filters: Filters;
  categories: ReadonlyArray<Category>;
  apply: (filters: Filters) => void;
}>;
type DraftProps = Readonly<{
  draft: Readonly<Record<string, string>>;
  change: (name: string, value: string) => void;
}>;
const FilterChoice = ({
  name,
  label,
  options,
  draft,
  change,
}: DraftProps &
  Readonly<{
    name: string;
    label: string;
    options: ReadonlyArray<readonly [string, string]>;
  }>): JSX.Element => (
  <ChoiceDropdown
    id={`recurring-filter-${name}`}
    label={label}
    value={draft[name] ?? ""}
    options={[{ value: "", label }, ...options.map(([value, text]) => ({ value, label: text }))]}
    disabled={false}
    width="auto"
    leading={null}
    triggerLabel={Option.none()}
    onChange={(value) => change(name, value)}
  />
);
const FilterChoices = ({
  categories,
  ...props
}: DraftProps & Pick<FilterProps, "categories">): JSX.Element => (
  <>
    <FilterChoice {...props} name="kind" label="Todos los tipos" options={kinds} />
    <FilterChoice {...props} name="frequency" label="Todas las frecuencias" options={frequencies} />
    <FilterChoice
      {...props}
      name="status"
      label="Todos los estados"
      options={Object.entries(statuses)}
    />
    <FilterChoice
      {...props}
      name="categoryId"
      label="Todas las categorías"
      options={categories.map((category) => [category.id, category.label])}
    />
    <SearchableChoiceDropdown
      id="recurring-filter-currency"
      label="Filtrar moneda"
      value={props.draft.currency ?? ""}
      options={[
        { value: "", label: "Todas las monedas" },
        ...Currency.literals.map((value) => ({ value, label: value })),
      ]}
      disabled={false}
      width="auto"
      onChange={(value) => props.change("currency", value)}
    />
  </>
);
export const FiltersForm = ({ filters, categories, apply }: FilterProps): JSX.Element => {
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => ({ ...filters }));
  const [invalid, setInvalid] = useState(false);
  const change = (name: string, value: string): void => setDraft({ ...draft, [name]: value });
  return (
    <section id="recurring-filters" aria-label="Filtrar recurrentes" data-recurring-slot="filters">
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Schema.decodeOption(RecurringFilters)(
            Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ""))
          );
          setInvalid(Option.isNone(parsed));
          if (Option.isSome(parsed)) apply(parsed.value);
        }}
      >
        <Input
          maxLength={searchLimit}
          name="search"
          aria-label="Buscar recurrentes"
          placeholder="Buscar recurrentes"
          className="max-w-64"
          value={draft.search ?? ""}
          onChange={(event) => change("search", event.target.value)}
        />
        <FilterChoices draft={draft} change={change} categories={categories} />
        <Button contentLayout="wrap" focusAppearance="subtle" type="submit" size="sm">
          Aplicar filtros
        </Button>
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setInvalid(false);
            setDraft({});
            apply({});
          }}
        >
          Limpiar
        </Button>
      </form>
      {invalid ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Revisa los filtros. La búsqueda admite hasta 120 caracteres.
        </p>
      ) : null}
    </section>
  );
};
