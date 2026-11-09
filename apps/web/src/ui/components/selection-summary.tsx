import { type JSX, useId, useRef, useState } from "react";
import { Button } from "./button";

type SelectionItem = Readonly<{
  id: string;
  label: string;
  description: string;
  hidden: boolean;
}>;

type SelectionSummaryProps = Readonly<{
  items: ReadonlyArray<SelectionItem>;
  label: string;
  disabled: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
  clearFocusId: string;
  showClear: boolean;
}>;
export const SelectionSummary = ({
  items,
  label,
  disabled,
  onRemove,
  onClear,
  clearFocusId,
  showClear,
}: SelectionSummaryProps): JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const inspectButton = useRef<HTMLButtonElement>(null);
  const clear = (): void => {
    document.getElementById(clearFocusId)?.focus();
    onClear();
  };
  const remove = (id: string): void => {
    if (items.length > 1) inspectButton.current?.focus();
    else document.getElementById(clearFocusId)?.focus();
    onRemove(id);
  };
  const hidden = items.filter((item) => item.hidden).length;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SelectionCount label={label} hidden={hidden} />
        {items.length > 0 ? (
          <>
            <Button
              contentLayout="wrap"
              ref={inspectButton}
              variant="outline"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              Revisar selección ({items.length})
            </Button>
            {showClear ? (
              <Button contentLayout="wrap" variant="ghost" disabled={disabled} onClick={clear}>
                Limpiar selección
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      <SelectionNotice hidden={hidden} />
      <ul
        id={listId}
        hidden={!expanded || items.length === 0}
        aria-label="Registros seleccionados"
        className="flex flex-col gap-3"
      >
        {items.map((item) => (
          <SelectionRow key={item.id} item={item} disabled={disabled} onRemove={remove} />
        ))}
      </ul>
    </div>
  );
};

const SelectionRow = ({
  item,
  disabled,
  onRemove,
}: Readonly<{
  item: SelectionItem;
  disabled: boolean;
  onRemove: (id: string) => void;
}>): JSX.Element => (
  <li className="flex flex-wrap items-center justify-between gap-3 border-b py-2">
    <div className="min-w-0 break-words">
      <p>{item.label}</p>
      <p className="text-sm text-muted-foreground">{item.description}</p>
      {item.hidden ? <p className="text-sm">Fuera del filtro</p> : null}
    </div>
    <Button
      contentLayout="wrap"
      variant="outline"
      disabled={disabled}
      aria-label={`Quitar ${item.label} de la selección`}
      onClick={() => onRemove(item.id)}
    >
      Quitar
    </Button>
  </li>
);

const SelectionCount = ({
  label,
  hidden,
}: Readonly<{ label: string; hidden: number }>): JSX.Element => (
  <p aria-live="polite">
    {label}
    {hidden > 0 ? (
      <>
        {" "}
        · <span>{hidden} fuera de este filtro</span>
      </>
    ) : null}
  </p>
);

const SelectionNotice = ({ hidden }: Readonly<{ hidden: number }>): JSX.Element =>
  hidden > 0 ? (
    <p className="text-sm text-muted-foreground">
      La acción incluye toda la selección, también los registros fuera del filtro.
    </p>
  ) : (
    <></>
  );
