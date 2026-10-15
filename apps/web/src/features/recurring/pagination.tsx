import { type JSX } from "react";
import { Button } from "@/ui/components/button";
import type { OccurrencePage } from "./use-occurrence-page";

export const OccurrencePages = ({
  page,
  total,
  label,
}: Readonly<{
  page: OccurrencePage;
  total: number;
  label: string;
}>): JSX.Element =>
  page.last === 0 ? (
    <></>
  ) : (
    <nav
      aria-label={`Páginas de ${label}`}
      className="flex flex-wrap items-center justify-center gap-3 border-t p-3"
    >
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        size="sm"
        variant="outline"
        disabled={page.current === 0}
        aria-label={`Página anterior de ${label}`}
        onClick={() => page.setPage(page.current - 1)}
      >
        Anterior
      </Button>
      <span className="text-xs tabular-nums">
        {page.start + 1}–{page.start + page.items.length} de {total}
      </span>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        size="sm"
        variant="outline"
        disabled={page.current === page.last}
        aria-label={`Página siguiente de ${label}`}
        onClick={() => page.setPage(page.current + 1)}
      >
        Siguiente
      </Button>
    </nav>
  );
