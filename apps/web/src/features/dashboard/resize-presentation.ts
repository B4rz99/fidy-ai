const minimumRegionPixels = 32;
const maximumMinimumShare = 0.49;
const resizeWeightPrecision = 1000;

/** Pointer geometry affects the preview only; the canonical edit still validates the weight. */
export const dashboardResizePreview = ({
  coordinate,
  start,
  end,
  weight,
  adjacentWeight,
  minimumWeight,
  maximumWeight,
}: Readonly<{
  coordinate: number;
  start: number;
  end: number;
  weight: number;
  adjacentWeight: number;
  minimumWeight: number;
  maximumWeight: number;
}>):
  | Readonly<{ _tag: "Available"; weight: number; adjacentWeight: number }>
  | Readonly<{ _tag: "Unavailable" }> => {
  const extent = end - start;
  if (extent <= 0) return { _tag: "Unavailable" };
  const minimumShare = Math.min(maximumMinimumShare, minimumRegionPixels / extent);
  const boundaryShare = Math.min(
    1 - minimumShare,
    Math.max(minimumShare, (coordinate - start) / extent)
  );
  const pairWeight = weight + adjacentWeight;
  const clamp = (value: number): number =>
    Math.round(Math.min(maximumWeight, Math.max(minimumWeight, value)) * resizeWeightPrecision) /
    resizeWeightPrecision;
  const nextWeight = clamp(
    Math.min(
      maximumWeight,
      pairWeight - minimumWeight,
      Math.max(minimumWeight, pairWeight - maximumWeight, pairWeight * boundaryShare)
    )
  );
  return { _tag: "Available", weight: nextWeight, adjacentWeight: clamp(pairWeight - nextWeight) };
};
