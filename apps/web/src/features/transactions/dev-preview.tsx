import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { type PreviewDataset, type PreviewProps, previewProps } from "./dev-fixtures";
import { TransactionWorkspace } from "./workspace-component";

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
  { value: "one", label: "One" },
  { value: "many", label: "500 rows" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const TransactionsDataPreview = (props: PreviewProps): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  return (
    <>
      <TransactionWorkspace key={dataset} {...previewProps({ props, dataset })} />
      <DevStressControls
        label="Transaction stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Read-only fixture")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/app/transactions",
            search: (previous) => ({ ...previous, data: next }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
