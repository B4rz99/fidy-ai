import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { fixturePATs } from "@/features/pats/dev-fixtures";
import { PATListPreviewContext } from "@/features/pats/fixture-context";
import { fixtureConnections } from "@/features/oauth-connections/dev-fixtures";
import { ConnectionListPreviewContext } from "@/features/oauth-connections/fixture-context";
import { AccessManagementPage } from "./access-page";

type PreviewDataset = "demo" | "worst" | "empty" | "one" | "many";

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
  { value: "empty", label: "Empty" },
  { value: "one", label: "One" },
  { value: "many", label: "25 rows" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const AccessDataPreview = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  return (
    <>
      <PATListPreviewContext value={(list) => fixturePATs({ list, dataset })}>
        <ConnectionListPreviewContext value={(list) => fixtureConnections({ list, dataset })}>
          <AccessManagementPage />
        </ConnectionListPreviewContext>
      </PATListPreviewContext>
      <DevStressControls
        label="Access stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Read-only fixture")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/settings/access",
            search: (previous) => ({
              ...previous,
              resume: previous.resume === "pat" ? "pat" : undefined,
              data: next,
            }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
