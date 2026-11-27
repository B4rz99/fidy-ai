import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { type JSX, type ReactNode, useRef } from "react";
import { ApplicationMenuAction, ApplicationWordmark } from "@/ui/components/application";
import { SignedInNavigation } from "./navigation";

const showNavigation = (dialog: HTMLDialogElement, trigger: HTMLButtonElement): void => {
  trigger.focus();
  dialog.showModal();

  if (Reflect.has(dialog, "closedBy")) return;

  const dismissBackdrop = (event: MouseEvent): void => {
    if (event.target !== dialog) return;

    const bounds = dialog.getBoundingClientRect();

    if (event.clientX < bounds.left || event.clientX >= bounds.right) dialog.close();
  };

  dialog.addEventListener("click", dismissBackdrop);
  dialog.addEventListener("close", () => dialog.removeEventListener("click", dismissBackdrop), {
    once: true,
  });
};

export const CompactNavigation = ({
  readOnly,
  loggingOut,
  onLogout,
  reviewPendingCount,
  prepareNavigation,
}: Readonly<{
  readOnly: boolean;
  loggingOut: boolean;
  onLogout: () => void;
  reviewPendingCount: ReactNode;
  prepareNavigation: (destination: string) => void;
}>): JSX.Element => {
  const drawer = useRef<HTMLDialogElement>(null);

  return (
    <>
      <div className="application-menu-control">
        <ApplicationMenuAction
          type="button"
          aria-label="Menú de navegación"
          aria-haspopup="dialog"
          aria-controls="signed-in-navigation"
          onClick={(event) => {
            if (drawer.current !== null) showNavigation(drawer.current, event.currentTarget);
          }}
        >
          <HugeiconsIcon icon={Menu01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
        </ApplicationMenuAction>
      </div>
      <dialog ref={drawer} id="signed-in-navigation" aria-label="Menú de navegación" closedby="any">
        <div className="application-menu-brand">
          <ApplicationWordmark />
          <ApplicationMenuAction
            type="button"
            aria-label="Cerrar menú"
            onClick={() => drawer.current?.close()}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
          </ApplicationMenuAction>
        </div>
        <SignedInNavigation
          readOnly={readOnly}
          loggingOut={loggingOut}
          onLogout={onLogout}
          reviewPendingCount={reviewPendingCount}
          prepareNavigation={prepareNavigation}
        />
      </dialog>
    </>
  );
};
