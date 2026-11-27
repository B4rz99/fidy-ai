import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Option } from "effect";
import type { JSX, ReactNode } from "react";
import { Button } from "@/ui/components/button";
import { Sheet, SheetClose, SheetContent } from "@/ui/components/sheet";
import type { Item } from "./model";
import { reviewTitle } from "./presentation";

export const MobileReviewDetail = ({
  children,
  item,
  open,
  onClose,
  returnFocus,
}: Readonly<{
  children: ReactNode;
  item: Option.Option<Item>;
  open: boolean;
  onClose: () => void;
  returnFocus: () => Option.Option<HTMLElement>;
}>): JSX.Element => (
  <Sheet
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
  >
    <SheetContent
      appearance="application-canvas"
      side="right"
      showCloseButton={false}
      finalFocus={() => Option.getOrElse(returnFocus(), () => false)}
      aria-label={Option.match(item, { onNone: () => "Detalle de revisión", onSome: reviewTitle })}
      data-review="mobile-detail"
      className="gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-none"
    >
      <div data-review="mobile-detail-bar">
        <SheetClose render={<Button variant="ghost" size="label" contentLayout="wrap" />}>
          <HugeiconsIcon icon={ArrowLeft01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
          Volver a Por revisar
        </SheetClose>
      </div>
      <div
        key={Option.getOrUndefined(Option.map(item, (selected) => selected.id))}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {children}
      </div>
    </SheetContent>
  </Sheet>
);
