import { Effect, Option } from "effect";
import {
  HostedInferenceError,
  type HostedInferenceService,
} from "~/shell/hosted-inference/contract";

/**
 * The application shell no longer owns a direct provider client. The Cloudflare Workers AI adapter
 * supplies this capability at the Worker seam; until that owner is assembled, every generation
 * attempt fails closed as a retryable provider-unavailable result.
 */
const unavailable = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "ProviderUnavailable" },
    retryable: true,
    retryAfter: Option.none(),
  });

const unavailableHostedInference: HostedInferenceService = {
  countText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
  countTranscript: (entries) =>
    Effect.succeed(new TextEncoder().encode(JSON.stringify(entries)).length),
  prepareText: () => Effect.fail(unavailable()),
  validateText: () => Effect.fail(unavailable()),
  prepareStructured: () => Effect.fail(unavailable()),
};

/** Provider-neutral live capability; the Cloudflare Worker provides the real Workers AI adapter. */
export const makeHostedInferenceLive: Effect.Effect<HostedInferenceService> = Effect.succeed(
  unavailableHostedInference
);
