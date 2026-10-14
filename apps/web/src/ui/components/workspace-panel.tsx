import { Option } from "effect";
import { useContext, useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet";

import { WorkspaceDesktop } from "./workspace-responsive";

const desktopQuery = "(min-width: 1280px)";
const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches;
const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

export const WorkspacePanel = ({
  children,
  open,
  locked,
  onClose,
  title,
  description,
}: Readonly<{
  children: ReactNode;
  open: boolean;
  locked: boolean;
  onClose: () => void;
  title: string;
  description: string;
}>): JSX.Element => {
  const viewportDesktop = useSyncExternalStore(subscribe, isDesktop);
  const containerDesktop = useContext(WorkspaceDesktop);
  const desktop = Option.getOrElse(containerDesktop, () => viewportDesktop);
  if (desktop) {
    return (
      <aside
        className={
          Option.isNone(containerDesktop)
            ? "self-stretch border-l bg-card p-6 xl:sticky xl:top-0 xl:min-h-[calc(100svh-72px)]"
            : "min-w-0 self-stretch border-l bg-card p-6"
        }
      >
        {children}
      </aside>
    );
  }
  if (!open) return <aside className="min-w-0 border-t bg-card p-5">{children}</aside>;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value && !locked) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        appearance="application"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-none"
      >
        <SheetHeader>
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        <div className="p-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
};
