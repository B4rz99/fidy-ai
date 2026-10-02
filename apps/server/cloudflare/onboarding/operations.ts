import type { OnboardingRequest } from "./contract";
import { complete } from "./internal/completion";

/**
 * Create one stable User only after mandatory mailbox proof, composing all owners in one atomic
 * unit. On rejection nothing stable is created; success discloses one recovery code without
 * issuing a WebSession. Origin and ingress policy must already have run.
 */
export const completeOnboarding = (input: OnboardingRequest): Promise<Response> => complete(input);
