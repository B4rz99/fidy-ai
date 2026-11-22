import { useNavigate, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX } from "react";
import { DevStressControls } from "@/ui/components/dev-stress-controls";
import { type PreviewDataset, fixtureOffers } from "./dev-fixtures";
import { OffersPreviewContext } from "./fixture-context";
import { SubscriptionOffersFeature } from "./feature";

const datasets: ReadonlyArray<Readonly<{ value: PreviewDataset; label: string }>> = [
  { value: "demo", label: "Demo data" },
  { value: "worst", label: "Worst case" },
];

const isDataset = (value: unknown): value is PreviewDataset =>
  datasets.some((item) => item.value === value);

export const SubscriptionDataPreview = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const raw = "data" in search ? search.data : undefined;
  const dataset = isDataset(raw) ? raw : "demo";

  return (
    <>
      <OffersPreviewContext value={(offers) => fixtureOffers({ offers, dataset })}>
        <SubscriptionOffersFeature />
      </OffersPreviewContext>
      <DevStressControls
        label="Subscription stress test"
        datasets={datasets}
        dataset={dataset}
        fixtureNote={dataset === "demo" ? Option.none() : Option.some("Fixture offers")}
        choose={(value) => {
          const next = isDataset(value) ? value : "demo";

          navigate({
            to: "/upgrade",
            search: (previous) => ({ ...previous, data: next }),
            replace: true,
          }).catch(() => undefined);
        }}
      />
    </>
  );
};
