import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, Image01Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/ui/components/badge";
import { useReviewExpired } from "./expiry";
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
  <aside data-review="inbox" aria-label="Bandeja de revisión">
    <div data-review="inbox-head">
      <h2>Vencen primero</h2>
      <span>
        {props.view.items.length} de {props.view.total}{" "}
        {props.view.total === 1 ? "elemento" : "elementos"}
      </span>
    </div>
    <div data-review="inbox-rows">
      {props.view.items.map((item) => (
        <ReviewRow key={item.id} item={item} props={props} />
      ))}
    </div>
    <ReviewPagination
      page={props.page}
      pageLength={props.pageLength}
      total={props.view.total}
      move={props.move}
    />
  </aside>
);

export const ReviewPagination = (
  props: Readonly<{
    page: number;
    pageLength: number;
    total: number;
    move: (offset: number) => void;
  }>
): JSX.Element => (
  <div data-review="pager">
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
      disabled={props.page + props.pageLength >= props.total}
      onClick={() => props.move(props.page + pageSize)}
    >
      Siguiente
    </Button>
  </div>
);

const ReviewRow = ({ item, props }: Readonly<{ item: Item; props: InboxProps }>): JSX.Element => {
  const expired = useReviewExpired(item);
  return (
    <div data-review="inbox-row" data-active={Option.contains(props.selected, item.id)}>
      <div data-review="row-check">
        <Checkbox
          aria-label={`Seleccionar ${sources[item.source]} ${item.id}`}
          checked={props.checked.includes(item.id)}
          disabled={expired || (item.status !== "pending" && item.status !== "skipped")}
          onCheckedChange={() => props.toggle(item)}
        />
      </div>
      <button
        type="button"
        aria-label={`Abrir ${sources[item.source]}`}
        data-review="row-content"
        onClick={() => props.choose(item)}
        aria-current={Option.contains(props.selected, item.id) ? "true" : undefined}
      >
        <span className="grid min-w-0 gap-2">
          <span data-review="row-source">
            <HugeiconsIcon
              icon={{ statement: File01Icon, media: Image01Icon, email: Mail01Icon }[item.source]}
              aria-hidden="true"
            />
            {sources[item.source]}
            {item.status === "pending" ? "" : ` · ${statuses[item.status]}`}
          </span>
          <span data-review="row-title">{reviewTitle(item)}</span>
          <span data-review="row-amount">{reviewAmount(item)}</span>
          <Badge variant="secondary" data-review="deadline" title={deadline(item)}>
            {reviewExpiry(item)}
          </Badge>
        </span>
      </button>
    </div>
  );
};
