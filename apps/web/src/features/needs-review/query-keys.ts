import type { Item } from "./model";

export const reviewWorkspaceKey = "ingestion-review-workspace";
export const reviewContextKey = "ingestion-review-context";
export const reviewCountKey = "ingestion-review-counts";
export const reviewItemKey = (id: Item["id"]): string => `ingestion-review-item:${id}`;
