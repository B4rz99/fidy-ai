import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { RecurringPlanStatus } from "@/ui/components/recurring";
import { type Plan, type Save, type planStatus, planToday } from "./model";

export const PlanLifecycle = ({
  plan,
  save,
  disabled,
  status,
}: Readonly<{
  plan: Plan;
  status: ReturnType<typeof planStatus>;
  save: Save;
  disabled: boolean;
}>): JSX.Element => {
  const pause = plan.pauses.find((entry) => entry.through === undefined);
  return (
    <RecurringPlanStatus
      status={status}
      action={
        plan.stoppedOn !== undefined ? null : (
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant={pause !== undefined ? "default" : "destructive"}
            disabled={disabled || (pause !== undefined && pause.from > planToday(plan))}
            onClick={() =>
              save({
                kind: "lifecycle",
                planId: plan.id,
                date: planToday(plan),
                action: pause !== undefined ? "resume" : "pause",
              })
            }
          >
            {pause !== undefined ? "Reanudar plan" : "Pausar plan"}
          </Button>
        )
      }
    />
  );
};
