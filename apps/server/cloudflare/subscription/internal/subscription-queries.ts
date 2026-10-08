import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  prepareSubscriptionOffers,
  prepareSubscriptionStatus,
} from "../../../src/shell/subscription/operations";
import { type PreparedSubscriptionRead } from "../../../src/shell/subscription/contract";
import { UserId } from "../../../src/core/identity/contract";
import { Clock, Effect } from "effect";
import { newId } from "../../secret-material/operations";
import { callerAuthority, isPATCaller } from "../../canonical-work/operations";
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
  const authority = callerAuthority({ subject, current });
  const read =
    operation === "subscription.listSubscriptionOffers"
      ? prepareSubscriptionOffers(authority)
      : prepareSubscriptionStatus({ userId: UserId.make(subject.userId), authority, current });
  const work = read.statements.map((statement) =>
    db.prepare(statement.sql).bind(...statement.params)
  );
  const use = pat
    ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
        db.prepare(sql).bind(...params)
      )
    : [];
  let audit: D1PreparedStatement;
  if (pat) {
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: { id: newId(), current, operation, outcome: "accepted", afterOwnerWrite: false },
    });
    audit = db.prepare(auditStatement.sql).bind(...auditStatement.params);
  } else {
    audit = prepareAuthorizedAuditCall({
      db,
      authority,
      id: newId(),
      operation,
      outcome: "accepted",
      current,
      afterOwnerWrite: false,
    });
  }
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
export const executeProtectedSubscriptionQuery = (input: QueryInput): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const prepared = subscriptionStatements(input, current);
    const results = yield* Effect.tryPromise(() => input.db.batch([...prepared.statements]));
    return presentSubscription({
      results,
      read: prepared.read,
      pat: isPATCaller(input.subject),
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));
