import type { JSX } from "react";
import { Skeleton } from "./skeleton";
import { RecurringIdentitySkeleton } from "./recurring-identity-loading";
import { RecurringOccurrenceColumns } from "./recurring-occurrence-columns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

export const RecurringOccurrenceDesktopSkeleton = (): JSX.Element => (
  <div className="hidden @min-5xl:block">
    <Table layout="fixed">
      <RecurringOccurrenceColumns />
      <TableHeader>
        <TableRow>
          {[0, 1, 2, 3, 4].map((column) => (
            <TableHead key={column} density="compact">
              <Skeleton className={`h-[18px] w-full max-w-20 ${column === 4 ? "ml-auto" : ""}`} />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {[0, 1, 2].map((row) => (
          <TableRow key={row}>
            <TableCell density="compact">
              <RecurringIdentitySkeleton />
            </TableCell>
            <TableCell density="compact">
              <Skeleton className="h-[1lh] w-full max-w-16" />
            </TableCell>
            <TableCell density="compact">
              <Skeleton className="h-[1lh] w-full max-w-32" />
            </TableCell>
            <TableCell density="compact">
              <div className="flex min-h-11 w-full items-center gap-2 py-1">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <Skeleton className="h-[1lh] w-2/5" />
                <Skeleton className="ml-auto size-4 shrink-0" />
              </div>
            </TableCell>
            <TableCell density="compact">
              <Skeleton className="ml-auto h-[1lh] w-full max-w-24" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);
