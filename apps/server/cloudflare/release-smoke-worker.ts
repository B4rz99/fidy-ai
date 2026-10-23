import type { SmokeExecutorEnvironment } from "./runtime/release-smoke/contract";
import { receiveSmoke } from "./runtime/release-smoke/operations";

export { ReleaseSmokeWorkflowV2 } from "./runtime/release-smoke/runtime";

/** Private Queue-only executor, deployed independently of zero-traffic Core candidates. */
export default {
  queue: (batch: MessageBatch<unknown>, environment: SmokeExecutorEnvironment): Promise<void> =>
    receiveSmoke({ batch, environment }),
} satisfies ExportedHandler<SmokeExecutorEnvironment>;
