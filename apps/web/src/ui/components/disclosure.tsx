import { type JSX, type ReactNode, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

type Props = Readonly<{ title: string; children: ReactNode }>;
const DisclosureHeading = ({ title }: Pick<Props, "title">): JSX.Element => (
  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium focus-visible:bg-muted focus-visible:underline [&::-webkit-details-marker]:hidden">
    <HugeiconsIcon
      icon={ArrowDown01Icon}
      className="size-4 -rotate-90 transition-transform group-open/disclosure:rotate-0"
    />
    {title}
  </summary>
);

export const Disclosure = ({ title, children }: Props): JSX.Element => (
  <details className="group/disclosure">
    <DisclosureHeading title={title} />
    {children}
  </details>
);

/** Mount requested content on first expansion; closing retains its fields and query owner. */
export const DeferredDisclosure = ({ title, children }: Props): JSX.Element => {
  const [visited, setVisited] = useState(false);
  return (
    <details
      className="group/disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <DisclosureHeading title={title} />
      {visited ? children : null}
    </details>
  );
};
