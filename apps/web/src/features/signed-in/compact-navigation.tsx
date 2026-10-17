import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import type { JSX, ReactNode } from "react";
import { Button } from "@/ui/components/button";
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
    <div className="px-2 md:hidden">
      <Button
        variant="outline"
        size="icon"
        popoverTarget="signed-in-navigation"
        aria-label="Menú de navegación"
      >
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
      </Button>
    </div>
    <div id="signed-in-navigation" className="signed-in-compact-navigation" popover="auto">
      <SignedInNavigation
        loggingOut={loggingOut}
        onLogout={onLogout}
        reviewPendingCount={reviewPendingCount}
      />
    </div>
  </>
);
