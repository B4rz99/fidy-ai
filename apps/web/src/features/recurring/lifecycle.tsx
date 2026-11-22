import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { RecurringPlanStatus } from "@/ui/components/recurring";
import { type Plan, type Save, dayLabel, planStatus, planToday } from "./model";

const ResumeTracking = ({
  plan,
  save,
  disabled,
  stoppedOn,
  status,
}: Readonly<{
  plan: Plan;
  save: Save;
  disabled: boolean;
  stoppedOn: string;
  status: ReturnType<typeof planStatus>;
}>): JSX.Element => {
  const open = plan.pauses.find((pause) => pause.through === undefined);
  const since = open !== undefined && open.from <= stoppedOn ? open.from : stoppedOn;
  const scheduled = status !== "stopped";

  return (
    <>
      <span className="text-xs text-muted-foreground">
        {scheduled
          ? `Detiene las fechas a partir del ${dayLabel(stoppedOn)}.`
          : `No generó fechas desde el ${dayLabel(since)}. Al reanudar, sigue desde hoy.`}
      </span>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          save({ kind: "lifecycle", planId: plan.id, date: planToday(plan), action: "resume" })
        }
      >
        {scheduled ? "Cancelar detención" : "Reanudar seguimiento"}
      </Button>
    </>
  );
};

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
  const stoppedOn = plan.stoppedOn;

  return (
    <RecurringPlanStatus
      status={status}
      action={
        stoppedOn !== undefined ? (
          <ResumeTracking
            plan={plan}
            save={save}
            disabled={disabled}
            stoppedOn={stoppedOn}
            status={status}
          />
        ) : (
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
