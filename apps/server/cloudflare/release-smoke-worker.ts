import { Effect } from "effect";
import type { AcceptanceProviderEnvironment } from "./release-fixture/contract";
import { acceptanceProviderResponse } from "./release-fixture/runtime";
import type { SmokeExecutorEnvironment } from "./runtime/release-smoke/contract";
import { receiveSmoke } from "./runtime/release-smoke/operations";

export { ReleaseSmokeWorkflowV2 } from "./runtime/release-smoke/runtime";

/** Revision-owned private smoke executor and closed provider transport. */
export default {
  fetch: (
    request: Request,
    environment: SmokeExecutorEnvironment & AcceptanceProviderEnvironment
  ): Promise<Response> => Effect.runPromise(acceptanceProviderResponse(request, environment)),
  queue: (batch: MessageBatch<unknown>, environment: SmokeExecutorEnvironment): Promise<void> =>
    receiveSmoke({ batch, environment }),
} satisfies ExportedHandler<SmokeExecutorEnvironment & AcceptanceProviderEnvironment>;
