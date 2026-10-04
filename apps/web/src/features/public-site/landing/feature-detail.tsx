import { detailViews } from "./detail-content";
import { features } from "./feature-content";
import { Registration } from "./registration";
import "./landing.css";

/** Presents one of the six approved product views; the route supplies its fixed index. */
export const FeatureDetail = ({ index }: { index: number }): React.JSX.Element => (
  <div className="fidy-landing variant-a feature-detail-open">
    <title>{`${features[index]?.label} — Fidy`}</title>
    <Registration>{detailViews[index]}</Registration>
  </div>
);
