import type { JSX, ReactNode } from "react";
import { Skeleton } from "./skeleton";

export const LoadingRegion = ({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>): JSX.Element => (
  <output className="flex min-w-0 flex-1 flex-col" aria-label={label} aria-busy="true">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="contents motion-reduce:[&_*]:animate-none">
      {children}
    </div>
  </output>
);

export const SelectionListSkeleton = ({ label }: Readonly<{ label: string }>): JSX.Element => (
  <LoadingRegion label={label}>
    <div className="grid gap-2">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-11 w-full" />
      ))}
    </div>
  </LoadingRegion>
);

export const TextSkeleton = ({
  label,
  lines,
}: Readonly<{ label: string; lines: number }>): JSX.Element => (
  <LoadingRegion label={label}>
    <div className="grid gap-3">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} className="h-4 w-full last:w-2/3" />
      ))}
    </div>
  </LoadingRegion>
);
