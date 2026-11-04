import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import { withRecoveryStore } from "../recovery-lifecycle/runtime";
import { runRecoveryOperation } from "../recovery-lifecycle/operations";
import { withErasureRecovery } from "../erasure/runtime";
import type { ProGrantOperatorEnvironment, ProGrantOperatorReply } from "./contract";
import { executeOperatorPro } from "./operations";

const unavailable = (): ProGrantOperatorReply => ({
  kind: "refused",
  reason: "unavailable",
  candidates: [],
});
/** Private account binding only. Default Core fetch and User credentials expose no operator command or SQL route. */
export class ProGrantService extends WorkerEntrypoint<ProGrantOperatorEnvironment> {
  execute(candidate: unknown): Promise<ProGrantOperatorReply> {
    if (this.env.RECOVERY_ISOLATION !== undefined && this.env.RECOVERY_ISOLATION !== "") {
      return Promise.resolve(unavailable());
    }
    return runRecoveryOperation({
      environment: this.env,
      work: () =>
        Effect.runPromise(
          Effect.gen({ self: this }, function* () {
            const selected = yield* Effect.try(() => withRecoveryStore(this.env));
            const { DB } = withErasureRecovery({ ...selected, ERASURE_REQUIRED: "true" });
            return yield* executeOperatorPro({ candidate, db: DB });
          }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
        ),
    }).catch(unavailable);
  }
}
