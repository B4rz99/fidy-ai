import { runRecoveryQueue } from "./recovery-lifecycle/operations";
import { withRecoveryDispatch } from "./recovery-lifecycle/runtime";
import type { RecoveryLifecycleEnvironment } from "./recovery-lifecycle/contract";
import type { SmokeExecutorEnvironment } from "./runtime/release-smoke/contract";
import { receiveSmoke } from "./runtime/release-smoke/operations";

export { ReleaseSmokeWorkflowV2 } from "./runtime/release-smoke/runtime";

/** Private Queue-only executor, deployed independently of zero-traffic Core candidates. */
export default {
  queue: (
    batch: MessageBatch<unknown>,
    environment: SmokeExecutorEnvironment & RecoveryLifecycleEnvironment
  ): Promise<void> =>
    runRecoveryQueue({
      environment,
      batch,
      work: () => receiveSmoke({ batch, environment: withRecoveryDispatch(environment) }),
    }),
} satisfies ExportedHandler<SmokeExecutorEnvironment & RecoveryLifecycleEnvironment>;
