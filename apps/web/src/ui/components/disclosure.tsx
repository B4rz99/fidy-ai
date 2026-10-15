import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

export const Disclosure = ({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>): JSX.Element => (
  <details className="group/disclosure">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium focus-visible:bg-muted focus-visible:underline [&::-webkit-details-marker]:hidden">
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        className="size-4 -rotate-90 transition-transform group-open/disclosure:rotate-0"
      />
      {title}
    </summary>
    {children}
  </details>
);
