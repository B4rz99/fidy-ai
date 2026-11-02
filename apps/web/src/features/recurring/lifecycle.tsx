import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { RecurringPlanStatus } from "@/ui/components/recurring";
import type { Plan, Save, planStatus } from "./model";

export const PlanLifecycle = ({
  plan,
  save,
  disabled,
  today,
  status,
}: Readonly<{
  plan: Plan;
  status: ReturnType<typeof planStatus>;
  save: Save;
  disabled: boolean;
  today: string;
}>): JSX.Element => (
  <RecurringPlanStatus
    status={status}
    action={
      status === "stopped" ? null : (
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant={status === "active" ? "destructive" : "default"}
          disabled={disabled}
          onClick={() =>
            save({
              kind: "lifecycle",
              planId: plan.id,
              date: today,
              action: status === "active" ? "pause" : "resume",
            })
          }
        >
          {status === "active" ? "Pausar plan" : "Reanudar plan"}
        </Button>
      )
    }
  />
);
