import type { Item } from "./model";

export const reviewWorkspaceKey = "ingestion-review-workspace";
export const reviewCountKey = "ingestion-review-counts";
export const reviewItemKey = (id: Item["id"]): string => `ingestion-review-item:${id}`;
