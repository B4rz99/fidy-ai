import { Schema } from "effect";

/**
 * Stable identity of a Category, independent of its label, display order, and taxonomy version.
 * Any slice may retain this value without importing the Categories slice that owns its metadata.
 */
export const CategoryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("CategoryId"))
  .annotate({ identifier: "CategoryId" });
export type CategoryId = typeof CategoryId.Type;
