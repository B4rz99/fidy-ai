import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  prepareSubscriptionOffers,
  prepareSubscriptionStatus,
} from "../../../src/shell/subscription/operations";
import { type PreparedSubscriptionRead } from "../../../src/shell/subscription/contract";
import { UserId } from "../../../src/core/identity/contract";
import { Effect } from "effect";
import { prepareOwnedStatement } from "../../database/operations";
import { currentMillis } from "../../runtime/operations";
import { newId } from "../../secret-material/operations";
import { isPATCaller } from "../../canonical-work/operations";
import { type SubscriptionQueryInput as QueryInput } from "../contract";

const headers = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
const unavailable = (): Response =>
  Response.json(
    {
      error: {
        code: "unavailable",
        message: "Subscription data is temporarily unavailable. Retry later.",
      },
      next: [],
    },
    { status: 503, headers }
  );
const refused = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401, headers }
  );
const auditResultIndex = -1;
const patUseResultIndex = -2;

const subscriptionStatements = (
  { db, subject, operation }: QueryInput,
  current: number
): Readonly<{ statements: ReadonlyArray<D1PreparedStatement>; read: PreparedSubscriptionRead }> => {
  const pat = isPATCaller(subject);
  const authority = pat
    ? livePATAuthority({ subject, current })
    : liveWebSessionAuthority({ subject, current });
  const read =
    operation === "subscription.listSubscriptionOffers"
      ? prepareSubscriptionOffers(authority)
      : prepareSubscriptionStatus({ userId: UserId.make(subject.userId), authority, current });
  const work = read.statements.map((statement) => prepareOwnedStatement({ db, statement }));
  const use = pat
    ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
    : [];
  const audit = pat
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
          input: { id: newId(), current, operation, outcome: "accepted", afterOwnerWrite: false },
        }),
      })
    : prepareAuthorizedAuditCall({
        db,
        authority,
        id: newId(),
        operation,
        outcome: "accepted",
        current,
        afterOwnerWrite: false,
      });
  return { statements: [...work, ...use, audit], read };
};

const presentSubscription = ({
  results,
  read,
  pat,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  read: PreparedSubscriptionRead;
  pat: boolean;
}>): Response => {
  if (
    results.at(auditResultIndex)?.meta.changes !== 1 ||
    (pat && results.at(patUseResultIndex)?.meta.changes !== 1)
  ) {
    return refused();
  }
  // The canonical codec rebuilds a closed JSON response, excluding provider and payment-source ids.
  return Response.json(
    { data: read.decode(results.map((result) => result.results)), next: [] },
    { headers }
  );
};

/** Commit one bounded query and its metadata-only AuditLogEntry under the same live User authority. */
export const executeProtectedSubscriptionQuery = (input: QueryInput): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = currentMillis();
      const prepared = subscriptionStatements(input, current);
      const results = yield* Effect.tryPromise(() => input.db.batch([...prepared.statements]));
      return presentSubscription({
        results,
        read: prepared.read,
        pat: isPATCaller(input.subject),
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );
