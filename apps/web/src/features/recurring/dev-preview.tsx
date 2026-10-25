import "./dev-preview.css";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { RecurringWorkspace } from "./workspace";
import {
  type Dataset,
  type PreviewProps,
  fixtureCategories,
  fixtureWorkspace,
} from "./dev-fixtures";
import type { Filters } from "./model";

const datasets: ReadonlyArray<Readonly<{ value: Dataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
  { value: "one", label: "One" },
  { value: "many", label: "500 rows" },
  { value: "stale", label: "Stale" },
];
const restoreEnvironment = (_element: HTMLDivElement): (() => void) => {
  const root = document.documentElement;
  const fontSize = root.style.fontSize;
  const dark = root.classList.contains("dark");
  return (): void => {
    root.style.fontSize = fontSize;
    root.classList.toggle("dark", dark);
  };
};
const FixtureWorkspace = ({
  props,
  dataset,
}: Readonly<{ props: PreviewProps; dataset: Dataset }>): JSX.Element => {
  const [filters, setFilters] = useState<Filters>({});
  const [capture, setCapture] = useState("");
  const categories = fixtureCategories(props.categories);
  const view = fixtureWorkspace({ dataset, categories, filters });
  return (
    <RecurringWorkspace
      {...props}
      view={view}
      categories={categories}
      filters={filters}
      applyFilters={setFilters}
      disabled={dataset === "stale"}
      save={(edit) => setCapture(`Acción capturada: ${edit.kind}. La prueba no guarda cambios.`)}
      notice={
        <output>
          {dataset === "stale"
            ? "Datos sin actualizar: acciones deshabilitadas en esta prueba."
            : capture}
        </output>
      }
      month={() => setCapture("El escenario fija octubre de 2026 para comparar las mismas fechas.")}
      earlier={() => setCapture("Sin más meses en este escenario de prueba.")}
    />
  );
};
export const RecurringDataPreview = (props: PreviewProps): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const dataset = "recurringData" in search ? (search.recurringData ?? "demo") : "demo";
  const [largeText, setLargeText] = useState(false);
  return (
    <>
      <div className="pb-24">
        {dataset === "demo" ? (
          <RecurringWorkspace {...props} />
        ) : (
          <FixtureWorkspace key={dataset} props={props} dataset={dataset} />
        )}
      </div>
      <div
        ref={restoreEnvironment}
        aria-label="Recurring stress test"
        className="recurring-stress-controls fixed bottom-3 left-1/2 z-50 flex w-max max-w-[95vw] -translate-x-1/2 flex-wrap justify-center gap-1 rounded-xl border bg-muted p-1 text-foreground shadow-sm"
      >
        <DatasetButtons
          dataset={dataset}
          choose={(value) => {
            navigate({
              to: "/app/recurring",
              search: { month: props.view.month, recurringData: value },
              replace: true,
            }).catch(() => undefined);
          }}
        />
        <button
          type="button"
          aria-pressed={largeText}
          className="rounded-lg px-2 py-1"
          onClick={() => {
            document.documentElement.style.fontSize = largeText ? "" : "32px";
            setLargeText(!largeText);
          }}
        >
          200% text
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1"
          onClick={() => document.documentElement.classList.toggle("dark")}
        >
          Dark mode
        </button>
        {dataset === "demo" ? null : <span className="self-center px-2">Fixture · no writes</span>}
      </div>
    </>
  );
};

const DatasetButtons = ({
  dataset,
  choose,
}: Readonly<{ dataset: Dataset; choose: (value: Dataset) => void }>): JSX.Element => (
  <>
    {datasets.map((item) => (
      <button
        key={item.value}
        type="button"
        aria-pressed={dataset === item.value}
        className={`rounded-lg px-2 py-1 ${dataset === item.value ? "bg-white text-black shadow-sm" : ""}`}
        onClick={() => choose(item.value)}
      >
        {item.label}
      </button>
    ))}
  </>
);
