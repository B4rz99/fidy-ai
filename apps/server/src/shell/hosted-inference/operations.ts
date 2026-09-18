import { Context, Layer } from "effect";
import { type HostedInferenceService, type HostedInferenceStubBehavior } from "./contract";
import { makeHostedInferenceLive } from "~/shell/hosted-inference/internal/live";
import { OutboundHttp } from "~/shell/outbound-http/operations";
import { makeHostedInferenceStubInternal } from "~/shell/hosted-inference/internal/stub";

/** Hosted inference authority acquired by Agent, Memory, and startup validation. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/hosted-inference/operations/HostedInference"
) {
  static readonly layer = Layer.effect(this, makeHostedInferenceLive).pipe(
    Layer.provide(OutboundHttp.openAiLayer)
  );
}

/** Builds deterministic hosted inference without exposing adapters or provider prompts. */
export const makeHostedInferenceStub = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => makeHostedInferenceStubInternal(behavior);
