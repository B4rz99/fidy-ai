import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { ReviewDetailContentSkeleton } from "./review-loading-content";
import "./review-workspace.css";

export const ReviewDetailSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando elemento">
    <ReviewDetailContentSkeleton />
  </LoadingRegion>
);
