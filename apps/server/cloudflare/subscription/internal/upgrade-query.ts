import { Clock, Effect, Option } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordedPATCallProof,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import {
  livePATAuthority,
  recordAuditedPATUseFromAuthority,
} from "../../../src/shell/tokens/operations";
import { isPATCaller, rateLimitedTransactionResponse } from "../../canonical-work/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { newId } from "../../secret-material/operations";
import type { SubscriptionQueryInput } from "../contract";

const unavailable = (): Response =>
  Response.json(
    { error: { code: "unavailable", message: "Upgrade guidance is unavailable." }, next: [] },
    { status: 503 }
  );
const refused = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );

/** Recovery guidance is guarded and audited but has no commercial consumption. */
export const queryUpgrade = (
  input: Extract<SubscriptionQueryInput, { operation: "subscription.getUpgradeUrl" }>
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, subject } = input;
      const current = yield* Clock.currentTimeMillis;
      const authority = isPATCaller(subject)
        ? livePATAuthority({ subject, current })
        : liveWebSessionAuthority({ subject, current });
      const auditId = newId();
      const rows = yield* Effect.tryPromise(() =>
        db.batch([
          prepareAuthorizedAuditCall({
            db,
            authority,
            id: auditId,
            operation: "subscription.getUpgradeUrl",
            outcome: "accepted",
            current,
            afterOwnerWrite: false,
          }),
          ...(isPATCaller(subject)
            ? [
                prepareOwnedStatement({
                  db,
                  statement: recordAuditedPATUseFromAuthority({
                    authority: livePATAuthority({ subject, current }),
                    current,
                    evidence: recordedPATCallProof({
                      auditId,
                      operation: "subscription.getUpgradeUrl",
                    }),
                  }),
                }),
              ]
            : []),
        ])
      );
      if (rows[0]?.meta.changes !== 1) return refused();
      return Response.json(
        {
          data: {
            url: new URL(
              "/upgrade",
              Option.getOrElse(input.browserOrigin, () => "https://app.fidyapp.com")
            ).href,
          },
          next: [],
        },
        { headers: { "cache-control": "no-store" } }
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          refusedByAuditBudget(cause) ? rateLimitedTransactionResponse() : unavailable()
        )
      )
    )
  );
