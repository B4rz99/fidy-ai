import { detailViews } from "./detail-content";
import { features } from "./feature-content";
import { LandingTheme } from "./theme";
import "./landing.css";

/** Presents one of the six approved product views; the route supplies its fixed index. */
export const FeatureDetail = ({ index }: { index: number }): React.JSX.Element => (
  <LandingTheme detail={true}>
    <title>{`${features[index]?.label} — Fidy`}</title>
    {detailViews[index]}
  </LandingTheme>
);
