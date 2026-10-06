import { Clock, Effect, Option } from "effect";
import type { CanonicalToolEvidence } from "../../../src/core/agent/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import type { HostedCommitFence } from "../contract";
import type { WhatsAppHostedSubject } from "../../whatsapp/contract";
import { transactionUnavailable } from "../../canonical-work/operations";
import {
  executeHostedStatementCall,
  executeHostedStatementQuery,
} from "../../canonical-operations/operations";
import { mintHostedStatementCaller } from "./statement-authority";
import { hostedAuthority } from "./hosted-authority";

type Context = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  subject: WhatsAppHostedSubject;
}>;

/** Only the server's exact-command path invokes this mutation callback. The minted guard checks
 * the consumed challenge's exact operation/input and original visible channel again at commit.
 */
export const whatsAppStatementMutationExecutor =
  ({
    db,
    bucket,
    subject,
  }: Context): ((
    operation: CatalogOperation["id"],
    input: CanonicalToolEvidence,
    fence: HostedCommitFence
  ) => Effect.Effect<Response>) =>
  (operation, input, fence) =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const caller = yield* mintHostedStatementCaller({
        db,
        subject,
        turnId: fence.turnId,
        current,
        live: hostedAuthority({ subject, current }),
        approval: Option.some({ operation, input }),
      });
      return Option.isNone(caller)
        ? transactionUnavailable()
        : yield* executeHostedStatementCall({
            db,
            bucket,
            caller: caller.value,
            current,
            operation,
            input,
            fence,
          });
    });

/** Use the installed read owner without lending the channel a WebSession or PAT. */
export const executeWhatsAppStatementQuery = ({
  db,
  bucket,
  subject,
  turnId,
  operation,
  input,
}: Context &
  Readonly<{
    turnId: HostedCommitFence["turnId"];
    operation: CatalogOperation["id"];
    input: CanonicalToolEvidence;
  }>): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const caller = yield* mintHostedStatementCaller({
      db,
      subject,
      turnId,
      current,
      live: hostedAuthority({ subject, current }),
      approval: Option.none(),
    });
    if (Option.isNone(caller)) return Option.none();
    return Option.some(
      yield* executeHostedStatementQuery({
        db,
        bucket,
        caller: caller.value,
        current,
        operation,
        input,
      })
    );
  });
