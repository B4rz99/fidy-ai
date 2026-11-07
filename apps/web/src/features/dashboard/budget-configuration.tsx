import { Option } from "effect";
import { createContext, useContext, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { FidyClient } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { DashboardBudgetDialog } from "@/ui/components/dashboard-budget-dialog";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BudgetWidget, DashboardGesture } from "./editor-model";
import type { DashboardLayout, DashboardView } from "./presentation";

import { DashboardBudgetEditor } from "./budget-editor";

type Configuration = Readonly<{
  disabled: boolean;
  open: (widget: BudgetWidget) => void;
}>;
const BudgetConfiguration = createContext<Option.Option<Configuration>>(Option.none());

export const ConfigureBudgetButton = ({
  widget,
  compact,
}: Readonly<{ widget: BudgetWidget; compact: boolean }>): JSX.Element => {
  const configuration = useContext(BudgetConfiguration);
  if (Option.isNone(configuration)) return <></>;
  return (
    <Button
      data-dashboard-budget={widget.id}
      aria-label={compact ? "Configurar presupuesto" : undefined}
      disabled={configuration.value.disabled}
      onClick={() => configuration.value.open(widget)}
      size={compact ? "icon" : "default"}
      type="button"
      variant={compact ? "ghost" : "default"}
    >
      {compact ? (
        <HugeiconsIcon icon={Settings01Icon} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        "Elegir presupuesto"
      )}
    </Button>
  );
};

export const DashboardBudgetActions = ({
  children,
  disabled,
  onOpen,
}: Readonly<{
  children: ReactNode;
  disabled: boolean;
  onOpen: (widget: BudgetWidget) => void;
}>): JSX.Element => (
  <BudgetConfiguration value={Option.some({ disabled, open: onOpen })}>
    {children}
  </BudgetConfiguration>
);

const findBudgetWidget = (layout: DashboardLayout, id: string): Option.Option<BudgetWidget> => {
  if (layout.kind === "leaf") {
    const { widget } = layout.widget;
    return widget.id === id && widget.type === "budget-bar" ? Option.some(widget) : Option.none();
  }
  return Option.fromUndefinedOr(
    layout.children.flatMap(({ node }) => Option.toArray(findBudgetWidget(node, id)))[0]
  );
};

type ConfigurationProps = Readonly<{
  apiClient: FidyClient;
  children: ReactNode;
  disabled: boolean;
  view: DashboardView;
  onGesture: (gesture: DashboardGesture) => void;
}>;
export const DashboardBudgetConfiguration = ({
  apiClient,
  children,
  disabled,
  view,
  onGesture,
}: ConfigurationProps): JSX.Element => {
  const [selectedId, setSelectedId] = useState(() => Option.none<BudgetWidget["id"]>());
  const widget = Option.flatMap(selectedId, (id) => findBudgetWidget(view.layout, id));
  const close = (): void => setSelectedId(Option.none());
  return (
    <BudgetConfiguration
      value={Option.some({
        disabled,
        open: (target) => {
          setSelectedId(Option.some(target.id));
        },
      })}
    >
      {children}
      <DashboardBudgetDialog open={Option.isSome(widget)} onClose={close}>
        {Option.isSome(widget) ? (
          <DashboardBudgetEditor
            key={`${widget.value.id}:${view.context.timeZone}`}
            apiClient={apiClient}
            timeZone={view.context.timeZone}
            widget={widget.value}
            disabled={disabled}
            onClose={close}
            onSave={(target) => {
              if (disabled) return;
              onGesture({ kind: "configure-budget", widget: widget.value, target });
              close();
            }}
          />
        ) : null}
      </DashboardBudgetDialog>
    </BudgetConfiguration>
  );
};
