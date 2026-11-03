import type { JSX } from "react";

export const PendingRead = ({ label }: Readonly<{ label: string }>): JSX.Element => (
  <output className="sr-only" aria-label={label} aria-busy="true">
    {label}
  </output>
);
