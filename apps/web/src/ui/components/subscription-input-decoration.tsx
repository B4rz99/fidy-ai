import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, JSX, ReactNode } from "react";

export const SubscriptionInputDecoration = ({
  icon,
  children,
}: Readonly<{
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  children: ReactNode;
}>): JSX.Element => (
  <span className="subscription-input-control">
    <HugeiconsIcon
      className="subscription-input-icon"
      icon={icon}
      size={24}
      strokeWidth={1.5}
      aria-hidden="true"
    />
    {children}
  </span>
);
