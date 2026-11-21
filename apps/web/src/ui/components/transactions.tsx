import { type JSX, type ReactNode, type RefCallback, useCallback, useRef } from "react";
import { Option, Schema } from "effect";
import { Button } from "./button";
import "./transactions.css";

const isHTMLElement = Schema.is(Schema.instanceOf(HTMLElement));

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

const noRestoreFocus = Option.none<(fallback: HTMLElement) => void>();

const focusReturn =
  (previous: HTMLElement, targetId: Option.Option<string>): ((fallback: HTMLElement) => void) =>
  (fallback): void => {
    const target = Option.flatMap(targetId, (id) =>
      Option.fromNullishOr(document.getElementById(id))
    );

    if (Option.isSome(target)) {
      target.value.focus({ preventScroll: true });
      target.value.scrollIntoView({ block: "center", behavior: "instant" });
    } else if (previous.isConnected && previous !== document.body) {
      previous.focus({ preventScroll: true });
    } else {
      fallback.focus();
    }
  };

const usePanelFocus = (active: boolean): RefCallback<HTMLDivElement> => {
  const restoreFocus = useRef(noRestoreFocus);

  return useCallback<RefCallback<HTMLDivElement>>(
    (node): void => {
      if (node === null) return;

      if (active) {
        const returnFocusId = Option.fromNullishOr(node.getAttribute("data-return-focus-id"));

        if (isHTMLElement(document.activeElement)) {
          if (Option.isSome(returnFocusId) || Option.isNone(restoreFocus.current)) {
            restoreFocus.current = Option.some(focusReturn(document.activeElement, returnFocusId));
          }
        }

        node.focus({ preventScroll: true });
      } else {
        Option.map(restoreFocus.current, (restore) => restore(node));
        restoreFocus.current = noRestoreFocus;
      }
    },
    [active]
  );
};

export const TransactionContextPanel = ({
  children,
  active,
  identity,
  locked,
  onClose,
  title,
  returnFocusId,
}: Readonly<{
  children: ReactNode;
  active: boolean;
  identity: string;
  locked: boolean;
  onClose: () => void;
  title: string;
  returnFocusId: Option.Option<string>;
}>): JSX.Element => {
  const focusPanel = usePanelFocus(active);

  const content = (
    <div
      key={identity}
      ref={focusPanel}
      tabIndex={-1}
      role={active ? "group" : undefined}
      aria-label={title}
      data-return-focus-id={Option.getOrUndefined(returnFocusId)}
    >
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
