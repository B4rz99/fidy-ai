import { useEffect } from "react";
import type { JSX, ReactNode } from "react";

export const VisibleReply = ({
  active,
  onVisible,
  children,
}: Readonly<{
  active: boolean;
  onVisible: () => void;
  children: ReactNode;
}>): JSX.Element => {
  useEffect((): void | (() => void) => {
    if (!active) return;
    const acknowledgeVisible = (): void => {
      if (document.visibilityState === "visible") onVisible();
    };
    acknowledgeVisible();
    document.addEventListener("visibilitychange", acknowledgeVisible);
    return (): void => document.removeEventListener("visibilitychange", acknowledgeVisible);
  }, [active, onVisible]);
  return <>{children}</>;
};
