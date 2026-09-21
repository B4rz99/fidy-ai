import { Context, Layer } from "effect";
import type { HostedInferenceService } from "./contract";
import { makeHostedInferenceLive } from "~/shell/hosted-inference/internal/live";

/** Hosted inference authority supplied by the Cloudflare Workers AI adapter. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/hosted-inference/operations/HostedInference"
) {
  static readonly layer = Layer.effect(this, makeHostedInferenceLive);
}
