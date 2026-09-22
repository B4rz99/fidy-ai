import { Context, type Effect, Layer } from "effect";
import type { HostedInferenceService, HostedInferenceStubBehavior } from "./contract";
import { makeHostedInferenceStubInternal } from "~/shell/hosted-inference/internal/stub";

/** Hosted inference authority supplied by the Cloudflare Workers AI adapter. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/hosted-inference/operations/HostedInference"
) {
  static readonly layer = <Error, Requirements>(
    service: Effect.Effect<HostedInferenceService, Error, Requirements>
  ): Layer.Layer<HostedInference, Error, Requirements> => Layer.effect(this, service);
}

/** Builds deterministic hosted inference without exposing adapters or provider prompts. */
export const makeHostedInferenceStub = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => makeHostedInferenceStubInternal(behavior);
