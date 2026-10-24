import { type JSX, type ReactNode, type RefCallback, useCallback, useRef } from "react";
import { Option } from "effect";
import { Button } from "./button";
import "./transactions.css";

export const TransactionSurface = ({
  children,
  panelOpen,
}: Readonly<{
  children: ReactNode;
  panelOpen: boolean;
}>): JSX.Element => (
  <main data-transaction-slot="transaction-workspace" data-panel-open={panelOpen}>
    {children}
  </main>
);

export const TransactionTypeToggle = ({
  value,
  onChange,
}: Readonly<{
  value: "inflow" | "outflow";
  onChange: (value: "inflow" | "outflow") => void;
}>): JSX.Element => (
  <fieldset data-transaction-slot="transaction-type-toggle" aria-label="Tipo de transacción">
    <Button
      type="button"
      variant="ghost"
      aria-pressed={value === "outflow"}
      onClick={() => onChange("outflow")}
    >
      Gasto
    </Button>
    <Button
      type="button"
      variant="ghost"
      aria-pressed={value === "inflow"}
      onClick={() => onChange("inflow")}
    >
      Ingreso
    </Button>
  </fieldset>
);

const noRestoreFocus = Option.none<HTMLElement>();

export const TransactionContextPanel = ({
  children,
  active,
  identity,
  locked,
  onClose,
  title,
}: Readonly<{
  children: ReactNode;
  active: boolean;
  identity: string;
  locked: boolean;
  onClose: () => void;
  title: string;
}>): JSX.Element => {
  const restoreFocus = useRef(noRestoreFocus);
  const focusPanel = useCallback<RefCallback<HTMLDivElement>>(
    (node): void => {
      if (node === null) return;
      if (active) {
        if (Option.isNone(restoreFocus.current) && document.activeElement instanceof HTMLElement) {
          restoreFocus.current = Option.some(document.activeElement);
        }
        node.focus({ preventScroll: true });
      } else {
        Option.map(restoreFocus.current, (element) => element.focus({ preventScroll: true }));
        restoreFocus.current = noRestoreFocus;
      }
    },
    [active]
  );
  const content = (
    <div key={identity} ref={focusPanel} tabIndex={-1}>
      {children}
    </div>
  );
  if (!active) {
    return (
      <aside data-transaction-slot="transaction-context-panel" aria-label={title}>
        {content}
      </aside>
    );
  }
  return (
    <dialog
      open
      aria-label={title}
      aria-modal={false}
      data-transaction-slot="transaction-context-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !locked) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {content}
    </dialog>
  );
};
