import type { Occurrence, Workspace } from "./model";

export const preservedDates = ({
  document,
  planId,
  from,
}: Readonly<{
  document: Workspace["document"];
  planId: Occurrence["planId"];
  from: string;
}>): ReadonlyArray<string> => {
  const exceptions = document.exceptions.filter((entry) => entry.planId === planId);
  return [
    ...new Set([
      ...exceptions.flatMap((entry) =>
        entry.replacement !== undefined || entry.skipped ? [entry.date] : []
      ),
      ...document.fulfillments.flatMap((entry) =>
        entry.planId === planId && !exceptions.some((exception) => exception.date === entry.date)
          ? [entry.date]
          : []
      ),
    ]),
  ]
    .filter((date) => date >= from)
    .sort();
};

export const hasOccurrenceTracking = ({
  document,
  item,
}: Readonly<{ document: Workspace["document"]; item: Occurrence }>): boolean =>
  item.fulfillments.length > 0 ||
  document.fulfillments.some((mark) => mark.planId === item.planId && mark.date === item.date);

export const preservesOccurrence = ({
  document,
  item,
}: Readonly<{ document: Workspace["document"]; item: Occurrence }>): boolean => {
  const exception = document.exceptions.find(
    (entry) => entry.planId === item.planId && entry.date === item.date
  );
  return exception === undefined
    ? hasOccurrenceTracking({ document, item })
    : exception.replacement !== undefined || exception.skipped;
};

export const restoredDates = ({
  document,
  planId,
  from,
}: Readonly<{
  document: Workspace["document"];
  planId: Occurrence["planId"];
  from: string;
}>): ReadonlyArray<string> =>
  document.exceptions
    .flatMap((entry) =>
      entry.planId === planId &&
      entry.date >= from &&
      !entry.skipped &&
      entry.replacement === undefined
        ? [entry.date]
        : []
    )
    .sort();
