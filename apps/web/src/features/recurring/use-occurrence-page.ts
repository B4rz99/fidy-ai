import { useState } from "react";
import type { Occurrence } from "./model";

export type OccurrencePage = Readonly<{
  items: ReadonlyArray<Occurrence>;
  current: number;
  last: number;
  start: number;
  setPage: (page: number) => void;
}>;
const pageSize = 20;
export const useOccurrencePage = (items: ReadonlyArray<Occurrence>): OccurrencePage => {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const current = Math.min(page, last);
  const start = current * pageSize;
  return { items: items.slice(start, start + pageSize), current, last, start, setPage };
};
