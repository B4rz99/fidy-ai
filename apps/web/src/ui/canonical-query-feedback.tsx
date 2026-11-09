import type { ComponentProps, JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

/** Retry belongs to the owning atom; Cause details never enter presentation. */
export const CanonicalQueryRetry = ({
  description,
  onRetry,
  retryLabel,
  variant = "outline",
  retryingLabel,
  title,
  waiting,
}: Readonly<{
  description: string;
  onRetry: () => void;
  retryLabel: string;
  retryingLabel: string;
  title: string;
  waiting: boolean;
}> &
  Pick<ComponentProps<typeof Button>, "variant">): JSX.Element => (
  <Alert variant="destructive">
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="flex flex-col items-start gap-3">
      <span>{description}</span>
      <Button disabled={waiting} onClick={onRetry} type="button" variant={variant}>
        {waiting ? retryingLabel : retryLabel}
      </Button>
    </AlertDescription>
  </Alert>
);
