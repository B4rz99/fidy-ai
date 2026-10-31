import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { ReviewInboxContentSkeleton } from "./review-loading-inbox";
import "./review-workspace.css";

export const ReviewInboxSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando elementos">
    <ReviewInboxContentSkeleton />
  </LoadingRegion>
);
