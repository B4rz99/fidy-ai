import { useNavigate, useSearch } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { type PreviewDataset, previewProps } from "./dev-fixtures";
import type { WorkspaceProps } from "./model";
import { BudgetWorkspace } from "./workspace";

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
  { value: "one", label: "One" },
  { value: "full", label: "16 categories" },
  { value: "many", label: "1,000 rows" },
];
const restoreTextSizeOnUnmount = (_element: HTMLDivElement): (() => void) => {
  const original = document.documentElement.style.fontSize;
  return (): void => {
    document.documentElement.style.fontSize = original;
  };
};
/** Dev-only fixture switch; production compilation removes its lazy import. */
export const BudgetDataPreview = (props: WorkspaceProps): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const dataset = "data" in search ? (search.data ?? "demo") : "demo";
  const [largeText, setLargeText] = useState(false);
  return (
    <>
      <BudgetWorkspace key={dataset} {...previewProps({ props, dataset })} />
      <div
        ref={restoreTextSizeOnUnmount}
        aria-label="Budget stress test"
        className="fixed bottom-3 left-1/2 z-50 flex w-max max-w-[95vw] -translate-x-1/2 flex-wrap justify-center gap-1 rounded-2xl border border-border bg-muted p-1 text-xs text-foreground shadow-sm"
        style={{ fontFamily: "system-ui" }}
      >
        {datasets.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={dataset === item.value}
            className={`rounded-xl px-2 py-1 ${dataset === item.value ? "bg-white shadow-sm" : ""}`}
            onClick={() => {
              navigate({
                to: "/app/budgets",
                search: { month: props.month, data: item.value },
                replace: true,
              }).catch(() => undefined);
            }}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={largeText}
          className="rounded-xl px-2 py-1"
          onClick={(): void => {
            document.documentElement.style.fontSize = largeText ? "" : "32px";
            setLargeText(!largeText);
          }}
        >
          200% text
        </button>
        {dataset !== "demo" ? <span className="self-center px-2">Read-only fixture</span> : null}
      </div>
    </>
  );
};
