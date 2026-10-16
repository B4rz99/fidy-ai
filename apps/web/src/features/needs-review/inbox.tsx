import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { type Item, type Workspace, deadline, sources, statuses } from "./model";
import { reviewAmount, reviewExpiry, reviewTitle } from "./presentation";

const pageSize = 50;
export type InboxProps = Readonly<{
  view: Workspace;
  selected: Option.Option<Item["id"]>;
  checked: ReadonlyArray<Item["id"]>;
  choose: (item: Item) => void;
  toggle: (item: Item) => void;
  page: number;
  pageLength: number;
  move: (offset: number) => void;
}>;
export const Inbox = (props: InboxProps): JSX.Element => (
  <aside
    className="flex min-h-0 min-w-0 flex-col border-b lg:border-r lg:border-b-0"
    aria-label="Bandeja de revisión"
  >
    <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4 text-xs text-muted-foreground">
      <h2>Vencen primero</h2>
      <span>
        {props.view.items.length} de {props.view.total} elementos
      </span>
    </div>
    <div className="max-h-[45svh] min-h-0 flex-1 overflow-auto lg:max-h-none">
      {props.view.items.map((item) => (
        <ReviewRow key={item.id} item={item} props={props} />
      ))}
    </div>
    <div className="flex shrink-0 gap-2 p-3">
      <Button
        variant="outline"
        size="sm"
        disabled={props.page === 0}
        onClick={() => props.move(Math.max(0, props.page - pageSize))}
      >
        Anterior
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={props.page + props.pageLength >= props.view.total}
        onClick={() => props.move(props.page + pageSize)}
      >
        Siguiente
      </Button>
    </div>
  </aside>
);

const ReviewRow = ({ item, props }: Readonly<{ item: Item; props: InboxProps }>): JSX.Element => (
  <div
    className={
      Option.contains(props.selected, item.id)
        ? "relative flex items-center border-b border-l-2 border-l-primary bg-secondary/35"
        : "relative flex items-center border-b border-l-2 border-l-transparent"
    }
  >
    <div className="absolute left-4 z-10 flex items-center">
      <Checkbox
        aria-label={`Seleccionar ${sources[item.source]} ${item.id}`}
        checked={props.checked.includes(item.id)}
        disabled={item.status !== "pending" && item.status !== "skipped"}
        onCheckedChange={() => props.toggle(item)}
      />
    </div>
    <button
      type="button"
      aria-label={`Abrir ${sources[item.source]}`}
      className="min-h-26 w-full min-w-0 cursor-pointer py-3 pr-5 pl-14 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => props.choose(item)}
      aria-current={Option.contains(props.selected, item.id) ? "true" : undefined}
    >
      <span className="grid min-w-0 gap-1.5">
        <span className="text-xs text-muted-foreground">
          {sources[item.source]}
          {item.status === "pending" ? "" : ` · ${statuses[item.status]}`}
        </span>
        <span className="truncate text-sm font-semibold">{reviewTitle(item)}</span>
        <span className="text-xs text-muted-foreground">{reviewAmount(item)}</span>
        <span className="text-xs font-medium" title={deadline(item)}>
          {reviewExpiry(item)}
        </span>
      </span>
    </button>
  </div>
);
