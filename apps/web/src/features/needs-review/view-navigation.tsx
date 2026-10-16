import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { Input } from "@/ui/components/input";

export type Filter = "pending" | "history" | "created" | "skipped" | "expired";
type Props = Readonly<{
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  count: number;
  refresh: () => void;
  source: string;
  setSource: (value: string) => void;
  search: string;
  setSearch: (value: string) => void;
}>;
const filters = [
  { value: "pending", label: "Pendientes" },
  { value: "history", label: "Historial" },
  { value: "created", label: "Creadas" },
  { value: "skipped", label: "Omitidas" },
  { value: "expired", label: "Vencidas" },
] as const;
export const ReviewNavigation = (props: Props): JSX.Element => (
  <nav
    aria-label="Vistas de revisión"
    className="flex flex-wrap items-center gap-3 border-b px-5 py-3"
  >
    <Button
      variant={props.filter === "pending" ? "secondary" : "ghost"}
      aria-pressed={props.filter === "pending"}
      onClick={() => props.select("pending", 0)}
    >
      Pendientes <span className="ml-2 tabular-nums">{props.count}</span>
    </Button>
    <Button
      variant={props.filter !== "pending" ? "secondary" : "ghost"}
      aria-pressed={props.filter !== "pending"}
      onClick={() => props.select("history", 0)}
    >
      Historial
    </Button>
    <ReviewFilters {...props} />
    <Button variant="ghost" size="sm" onClick={props.refresh}>
      Actualizar
    </Button>
  </nav>
);
const ReviewFilters = (props: Props): JSX.Element => (
  <div className="ml-auto flex min-w-0 flex-wrap gap-3">
    {props.filter !== "pending" ? (
      <ChoiceDropdown
        id="review-status"
        label="Mostrar historial"
        value={props.filter}
        options={filters.filter((option) => option.value !== "pending")}
        disabled={false}
        leading={null}
        triggerLabel={Option.none()}
        width="auto"
        onChange={(value) => {
          const next = filters.find((option) => option.value === value);
          if (next !== undefined) props.select(next.value, 0);
        }}
      />
    ) : null}
    <ChoiceDropdown
      id="review-source"
      label="Filtrar por origen en esta página"
      value={props.source}
      options={[
        { value: "all", label: "Todos los orígenes" },
        { value: "statement", label: "Extractos" },
        { value: "media", label: "Imágenes" },
        { value: "email", label: "Correos" },
      ]}
      disabled={false}
      leading={null}
      triggerLabel={Option.none()}
      width="auto"
      onChange={props.setSource}
    />
    <div className="w-full sm:w-60">
      <Input
        aria-label="Buscar pendientes en esta página"
        placeholder="Buscar pendiente…"
        value={props.search}
        onChange={(event) => props.setSearch(event.target.value)}
      />
    </div>
  </div>
);
