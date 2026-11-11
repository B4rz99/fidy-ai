import { DateTime } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import type { Item } from "./model";
import { originalDeadlineQuery } from "./original-deadline";

const expiredMaterial: CanonicalSuccess<"ingestion.getReviewMaterial"> = {
  data: { available: false, reason: "expired" },
  next: [],
};
/** Immutable evidence keeps only a short preload/commit bridge; expired bounds prevent another read. */
export const reviewMaterialQuery = ({
  client,
  item,
}: Readonly<{
  client: FidyClient;
  item: Pick<Item, "id" | "expiresAt">;
}>): Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewMaterial">, unknown>
> => {
  const material = client.query("ingestion", "getReviewMaterial", {
    params: { id: item.id },
    reactivityKeys: ["ingestion-review-original"],
    timeToLive: "400 millis",
  });
  return Atom.readable(
    (get) => {
      const deadline = get(originalDeadlineQuery(item));
      if (DateTime.toEpochMillis(deadline) <= DateTime.toEpochMillis(DateTime.nowUnsafe())) {
        return AsyncResult.success(expiredMaterial);
      }
      return get(material);
    },
    (refresh) => refresh(material)
  );
};
