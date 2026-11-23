import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type ComponentProps, type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { type PreviewDataset, fixtureDetail, fixtureView } from "./dev-fixtures";
import { FixtureDetailContext, WorkspacePreviewContext } from "./fixture-context";
import { NeedsReviewFeature } from "./workspace";

type Props = ComponentProps<typeof NeedsReviewFeature>;

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
  { value: "one", label: "One" },
  { value: "many", label: "50 items" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const NeedsReviewDataPreview = (props: Props): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  return (
    <>
      <WorkspacePreviewContext value={(view, scope) => fixtureView({ view, dataset, scope })}>
        <FixtureDetailContext
          value={(item) => (dataset === "demo" ? Option.none() : Option.some(fixtureDetail(item)))}
        >
          <NeedsReviewFeature {...props} />
        </FixtureDetailContext>
      </WorkspacePreviewContext>
      <DevStressControls
        label="Needs review stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Read-only fixture")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/app/needs-review",
            search: (previous) => ({ ...previous, data: next }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
