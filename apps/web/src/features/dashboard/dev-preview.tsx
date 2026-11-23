import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type ComponentProps, type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { type PreviewDataset, fixtureCatalog, fixtureView } from "./dev-fixtures";
import { DashboardViewComponent } from "./view";

type Props = ComponentProps<typeof DashboardViewComponent>;

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const DashboardDataPreview = (props: Props): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  const view = fixtureView({ view: props.view, dataset });

  const editor = Option.map(props.editor, (value) => ({
    ...value,
    catalog: fixtureCatalog({ catalog: value.catalog, dataset }),
  }));

  return (
    <>
      <DashboardViewComponent key={dataset} {...props} view={view} editor={editor} />
      <DevStressControls
        label="Dashboard stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Read-only fixture")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/app/dashboard",
            search: (previous) => ({ ...previous, data: next }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
