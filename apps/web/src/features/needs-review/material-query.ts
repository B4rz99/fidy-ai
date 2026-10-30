import type { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

/** Immutable evidence keeps only a short preload/commit bridge; display still enforces its deadline. */
export const reviewMaterialQuery = (
  client: FidyClient,
  id: CanonicalSuccess<"ingestion.getReviewItem">["data"]["item"]["id"]
): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewMaterial">, unknown>> =>
  client.query("ingestion", "getReviewMaterial", {
    params: { id },
    reactivityKeys: ["ingestion-review-original"],
    timeToLive: "400 millis",
  });
