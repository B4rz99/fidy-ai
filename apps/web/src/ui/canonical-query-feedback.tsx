import type { JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

/**
 * Renders safe canonical-query feedback and dispatches retry through the owning atom callback.
 * Copy is supplied by the feature; Cause details never enter this presentation boundary.
 */
export const CanonicalQueryRetry = ({
  description,
  onRetry,
  retryLabel,
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
}>): JSX.Element => (
  <Alert variant="destructive">
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="flex flex-col items-start gap-3">
      <span>{description}</span>
      <Button disabled={waiting} onClick={onRetry} type="button" variant="outline">
        {waiting ? retryingLabel : retryLabel}
      </Button>
    </AlertDescription>
  </Alert>
);
