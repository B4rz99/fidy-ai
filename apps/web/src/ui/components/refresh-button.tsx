import { Refresh04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, JSX } from "react";
import { Button } from "./button";

type Props = Omit<ComponentProps<typeof Button>, "children" | "size" | "aria-label" | "title"> &
  Readonly<{ label: string }>;

export const RefreshButton = ({ label, variant = "outline", ...props }: Props): JSX.Element => (
  <Button {...props} variant={variant} size="icon" aria-label={label} title={label}>
    <HugeiconsIcon icon={Refresh04Icon} aria-hidden="true" />
  </Button>
);
