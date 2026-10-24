import { Badge } from "@/ui/components/badge";
import { RefreshButton } from "@/ui/components/refresh-button";
import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { Input } from "@/ui/components/input";

export type Filter = "pending" | "history" | "created" | "skipped" | "expired";
type Props = Readonly<{
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  count: Option.Option<number>;
  unavailable: boolean;
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
  <nav aria-label="Vistas de revisión" data-review="navigation">
    <div data-review="tabs">
      <Button
        variant={props.filter === "pending" ? "secondary" : "ghost"}
        aria-pressed={props.filter === "pending"}
        onClick={() => props.select("pending", 0)}
      >
        Pendientes{" "}
        {Option.isSome(props.count) ? <Badge variant="secondary">{props.count.value}</Badge> : null}
      </Button>
      <Button
        variant={props.filter !== "pending" ? "secondary" : "ghost"}
        aria-pressed={props.filter !== "pending"}
        onClick={() => props.select("history", 0)}
      >
        Historial
      </Button>
    </div>
    <ReviewFilters {...props} />
    <RefreshButton variant="ghost" onClick={props.refresh} label="Actualizar" />
  </nav>
);
const ReviewFilters = (props: Props): JSX.Element => (
  <div data-review="filters">
    {props.filter !== "pending" ? (
      <ChoiceDropdown
        id="review-status"
        label="Mostrar historial"
        value={props.filter}
        options={filters.filter((option) => option.value !== "pending")}
        disabled={props.unavailable}
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
      disabled={props.unavailable}
      leading={null}
      triggerLabel={Option.none()}
      width="auto"
      onChange={props.setSource}
    />
    <div data-review="search">
      <Input
        aria-label="Buscar pendientes en esta página"
        placeholder="Buscar pendiente…"
        value={props.search}
        disabled={props.unavailable}
        onChange={(event) => props.setSearch(event.target.value)}
      />
    </div>
  </div>
);
