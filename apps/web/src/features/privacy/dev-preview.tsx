import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { type PreviewDataset, fixtureConsent } from "./dev-fixtures";
import { ConsentStatusPreviewContext } from "./fixture-context";
import { PrivacyFeature } from "./feature";

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "granted", label: "Granted" },
  { value: "missing", label: "Missing" },
  { value: "revoked", label: "Revoked" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const PrivacyDataPreview = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  return (
    <>
      <ConsentStatusPreviewContext value={(status) => fixtureConsent({ status, dataset })}>
        <PrivacyFeature />
      </ConsentStatusPreviewContext>
      <DevStressControls
        label="Privacy stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Fixture status")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/settings/privacy",
            search: (previous) => ({ ...previous, data: next }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
