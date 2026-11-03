import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import type { CreationResultProps, Occurrence } from "./model";
import { PlanForm } from "./plan-form";

export const CreationCorrection = ({
  item,
  categories,
  disabled,
  save,
}: Pick<CreationResultProps, "categories" | "disabled" | "save"> &
  Readonly<{ item: Occurrence }>): JSX.Element => {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Si no esperas otro pago o ingreso para esta fecha, cambia la primera fecha del nuevo plan.
      </p>
      <Button variant="outline" disabled={disabled} onClick={() => setEditing(!editing)}>
        Cambiar primera fecha
      </Button>
      {editing ? (
        <PlanForm
          key={JSON.stringify(item.plan)}
          initial={{ ...item.plan, firstDate: item.expectedDate }}
          categories={categories}
          disabled={disabled}
          onSubmit={(plan) =>
            save({ kind: "edit", planId: item.planId, date: item.date, scope: "forward", plan })
          }
        />
      ) : null}
    </>
  );
};
