import { useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/components/sheet";

const desktopQuery = "(min-width: 1280px)";
const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches;
const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
/** Shares one panel instance across a desktop rail and an accessible full-screen mobile sheet. */
export const ResponsiveTransactionPanel = ({
  children,
  open,
  locked,
  onClose,
  title,
}: Readonly<{
  children: ReactNode;
  open: boolean;
  locked: boolean;
  onClose: () => void;
  title: string;
}>): JSX.Element => {
  const desktop = useSyncExternalStore(subscribe, isDesktop);
  if (desktop) {
    return (
      <aside className="self-stretch border-l bg-card p-6 xl:sticky xl:top-0 xl:min-h-[calc(100svh-72px)]">
        {children}
      </aside>
    );
  }
  if (!open) return <aside className="border-t bg-card p-5">{children}</aside>;
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
          <SheetDescription className="sr-only">
            Revisa o registra una transacción.
          </SheetDescription>
        </SheetHeader>
        <div className="p-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
};
