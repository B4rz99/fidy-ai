import { PublicMetadata } from "@/features/public-site/metadata";
import { detailViews } from "./detail-content";
import { features } from "./feature-content";
import { LandingTheme } from "./theme";
import "./landing.css";

/** Presents one of the six approved product views; the route supplies its fixed index. */
export const FeatureDetail = ({ index }: { index: number }): React.JSX.Element => (
  <LandingTheme detail={true}>
    <PublicMetadata
      title={`${features[index]?.label} — Fidy`}
      path={`/funciones/${features[index]?.slug}`}
      description={`Explora ${features[index]?.label} en Fidy: tus finanzas personales con contexto y control.`}
    />
    {detailViews[index]}
  </LandingTheme>
);
