import { useState } from "react";
import type { JSX } from "react";
import { Option } from "effect";
import { Restaurant01Icon, ShoppingCart01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/ui/components/button";
import { CalendarField } from "@/ui/components/calendar-field";
import { ChoiceDropdown, InlineChoiceDropdown } from "@/ui/components/choice-dropdown";
import { HeaderSearch } from "@/ui/components/header-search";
import { DirectionIndicator, IconIndicator } from "@/ui/components/icon-indicator";
import { RecordToolbar, WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";
import { WorkspacePanel } from "@/ui/components/workspace-panel";

const categoryOptions = [
  { value: "restaurants", label: "Restaurantes" },
  { value: "groceries", label: "Mercado" },
];
const ChoiceReference = (): JSX.Element => {
  const [category, setCategory] = useState("restaurants");
  return (
    <>
      <RecordToolbar>
        <ChoiceDropdown
          id="reference-category-filter"
          label="Categoría de ejemplo"
          value={category}
          options={categoryOptions}
          disabled={false}
          width="auto"
          leading={null}
          triggerLabel={Option.some("Categorías")}
          onChange={setCategory}
        />
        <Button variant="outline" disabled>
          Editar varias
        </Button>
      </RecordToolbar>
      <InlineChoiceDropdown
        label="Cambiar categoría del ejemplo"
        disabled={false}
        leading={
          <IconIndicator
            icon={category === "restaurants" ? Restaurant01Icon : ShoppingCart01Icon}
            tone={category === "restaurants" ? "rose" : "sage"}
            appearance="category"
          />
        }
        value={category}
        options={categoryOptions}
        onChange={setCategory}
      >
        {categoryOptions.find((option) => option.value === category)?.label}
      </InlineChoiceDropdown>
      <div className="mt-4 flex flex-wrap gap-4">
        <span className="flex items-center gap-2">
          <DirectionIndicator inflow={false} />
          Gasto · $ 28.000,00
        </span>
        <span className="flex items-center gap-2">
          <DirectionIndicator inflow />
          Ingreso · $ 50.000,00
        </span>
      </div>
    </>
  );
};

/** Interactive local examples share the application controls without requesting domain transitions. */
export const WorkspaceReference = (): JSX.Element => {
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [date, setDate] = useState("2026-10-09");
  return (
    <section aria-label="Patrones de aplicación" className="overflow-hidden rounded-xl border">
      <WorkspaceHeader
        title="Patrones de aplicación"
        context={<span className="sr-only">Datos de ejemplo</span>}
      >
        <HeaderSearch
          value={search}
          onChange={setSearch}
          open={searching}
          onOpenChange={setSearching}
          disabled={false}
          label="Buscar en el ejemplo"
        />
        <CalendarField
          id="reference-calendar"
          label="Fecha del ejemplo"
          value={date}
          timeZone="America/Bogota"
          disabled={false}
          required={false}
          appearance="filter"
          onChange={setDate}
        />
      </WorkspaceHeader>
      <WorkspaceColumns
        panel={
          <WorkspacePanel
            open={false}
            locked={false}
            onClose={() => undefined}
            title="Resumen del ejemplo"
            description="Esta referencia no guarda transacciones."
          >
            <h2 className="text-2xl font-semibold">Resumen</h2>
            <p className="mt-4 text-muted-foreground">
              Ejemplos locales. Ningún control cambia tus datos.
            </p>
          </WorkspacePanel>
        }
      >
        <ChoiceReference />
        <p className="mt-4 text-sm text-muted-foreground">
          La búsqueda y las selecciones permanecen en esta referencia.
        </p>
      </WorkspaceColumns>
    </section>
  );
};
