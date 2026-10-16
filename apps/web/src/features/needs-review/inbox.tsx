import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Badge } from "@/ui/components/badge";
import { type Item, type Workspace, deadline, sources, statuses } from "./model";

const pageSize = 50;
export type InboxProps = Readonly<{
  view: Workspace;
  selected: Option.Option<Item["id"]>;
  checked: ReadonlyArray<Item["id"]>;
  choose: (item: Item) => void;
  toggle: (item: Item) => void;
  page: number;
  move: (offset: number) => void;
}>;
export const Inbox = (props: InboxProps): JSX.Element => (
  <aside className="min-w-0 border-b lg:border-r lg:border-b-0" aria-label="Bandeja de revisión">
    <div className="border-b p-4">
      <h2 className="font-medium">{props.view.total} elementos</h2>
      <p className="mt-1 text-xs text-muted-foreground">Primero los que vencen antes</p>
    </div>
    <div className="max-h-[45svh] overflow-auto lg:max-h-[calc(100svh-15rem)]">
      {props.view.items.map((item) => (
        <div
          key={item.id}
          className={
            Option.contains(props.selected, item.id)
              ? "flex gap-2 border-b bg-secondary/50 p-3"
              : "flex gap-2 border-b p-3"
          }
        >
          <Checkbox
            aria-label={`Seleccionar ${sources[item.source]} ${item.id}`}
            checked={props.checked.includes(item.id)}
            disabled={item.status !== "pending" && item.status !== "skipped"}
            onCheckedChange={() => props.toggle(item)}
          />
          <Button
            type="button"
            variant="ghost"
            contentLayout="wrap"
            className="h-auto min-w-0 flex-1 justify-start"
            onClick={() => props.choose(item)}
            aria-current={Option.contains(props.selected, item.id) ? "true" : undefined}
          >
            <span className="grid min-w-0 gap-2 text-left">
              <span className="font-medium">{sources[item.source]}</span>
              <Badge variant="secondary">{statuses[item.status]}</Badge>
              <span className="text-xs text-muted-foreground">Vence {deadline(item)}</span>
            </span>
          </Button>
        </div>
      ))}
    </div>
    <div className="flex gap-2 p-3">
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
        disabled={props.page + props.view.items.length >= props.view.total}
        onClick={() => props.move(props.page + pageSize)}
      >
        Siguiente
      </Button>
    </div>
  </aside>
);
