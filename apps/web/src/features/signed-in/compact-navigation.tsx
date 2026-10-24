import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import type { JSX, ReactNode } from "react";
import { ApplicationMenuAction, ApplicationWordmark } from "@/ui/components/application";
import { SignedInNavigation } from "./navigation";

export const CompactNavigation = ({
  loggingOut,
  onLogout,
  reviewPendingCount,
}: Readonly<{
  loggingOut: boolean;
  onLogout: () => void;
  reviewPendingCount: ReactNode;
}>): JSX.Element => (
  <>
    <div className="application-menu-control">
      <ApplicationMenuAction popoverTarget="signed-in-navigation" aria-label="Menú de navegación">
        <HugeiconsIcon
          className="signed-in-menu-bars"
          icon={Menu01Icon}
          size={24}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <HugeiconsIcon
          className="signed-in-menu-close"
          icon={Cancel01Icon}
          size={24}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </ApplicationMenuAction>
    </div>
    <div id="signed-in-navigation" className="signed-in-compact-navigation" popover="auto">
      <div className="application-menu-brand">
        <ApplicationWordmark />
      </div>
      <SignedInNavigation
        loggingOut={loggingOut}
        onLogout={onLogout}
        reviewPendingCount={reviewPendingCount}
      />
    </div>
  </>
);
