import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { RecurringPlanStatus } from "@/ui/components/recurring";
import { type Plan, type Save, planStatus, planToday } from "./model";

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
        plan.stoppedOn !== undefined || status === "stopped" ? null : (
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
            {lifecycleLabel({ plan, status, disabled })}
          </Button>
        )
      }
    />
  );
};

const lifecycleLabel = ({
  plan,
  status,
  disabled,
}: Readonly<{
  plan: Plan;
  status: ReturnType<typeof planStatus>;
  disabled: boolean;
}>): string => {
  if (disabled && status !== planStatus(plan)) {
    return status === "paused" ? "Reanudar plan" : "Pausar plan";
  }
  return plan.pauses.some((pause) => pause.through === undefined) ? "Reanudar plan" : "Pausar plan";
};
