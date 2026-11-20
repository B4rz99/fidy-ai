import { cn } from "@/ui/class-names";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";

export const SearchableChoiceLabel = ({
  label,
  width,
}: Readonly<{ label: string; width: "full" | "auto" }>): JSX.Element => (
  <>
    <span className={cn("min-w-0 whitespace-normal text-left", width === "full" && "flex-1")}>
      {label}
    </span>
    <HugeiconsIcon
      icon={ArrowDown01Icon}
      strokeWidth={1.5}
      data-icon="inline-end"
      aria-hidden="true"
    />
  </>
);
