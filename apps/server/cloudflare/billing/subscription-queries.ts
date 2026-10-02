import { prepareAuthorizedAuditCall, recordCanonicalPATWork } from "@fidy/server/audit";
import { liveWebSessionAuthority } from "@fidy/server/identity-operations";
import { livePATAuthority, recordLivePATUse } from "@fidy/server/tokens-runtime";
import {
  SubscriptionOffers,
  SubscriptionStatus,
  projectSubscriptionOffers,
  projectSubscriptionStatus,
  subscriptionAttemptsQuery,
  subscriptionOffersQuery,
  subscriptionStandingQuery,
} from "@fidy/server/subscription-runtime";
import { Effect, Option, Schema } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { currentMillis, newId } from "../pats/pat-shared";
import { type TransactionCaller, isPATCaller } from "../canonical-work/operations";

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
type SubscriptionQuery =
  | "subscription.listSubscriptionOffers"
  | "subscription.getSubscriptionStatus";
type QueryInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: SubscriptionQuery;
}>;

const subscriptionStatements = (
  { db, subject, operation }: QueryInput,
  current: number
): ReadonlyArray<D1PreparedStatement> => {
  const pat = isPATCaller(subject);
  const authority = pat
    ? livePATAuthority({ subject, current })
    : liveWebSessionAuthority({ subject, current });
  const work =
    operation === "subscription.listSubscriptionOffers"
      ? [prepareOwnedStatement({ db, statement: subscriptionOffersQuery(Option.some(authority)) })]
      : [
          prepareOwnedStatement({
            db,
            statement: subscriptionStandingQuery({
              userId: subject.userId,
              authority: Option.some(authority),
            }),
          }),
          prepareOwnedStatement({
            db,
            statement: subscriptionAttemptsQuery({
              userId: subject.userId,
              authority: Option.some(authority),
            }),
          }),
        ];
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
  return [...work, ...use, audit];
};

const subscriptionData = ({
  results,
  operation,
  current,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: SubscriptionQuery;
  current: number;
}>): unknown =>
  operation === "subscription.listSubscriptionOffers"
    ? Schema.encodeSync(Schema.toCodecJson(SubscriptionOffers))(
        projectSubscriptionOffers(results[0]?.results ?? [])
      )
    : Schema.encodeSync(Schema.toCodecJson(SubscriptionStatus))(
        projectSubscriptionStatus({
          standingRow: results[0]?.results[0],
          attemptRows: results[1]?.results ?? [],
          now: current,
        })
      );

const presentSubscription = ({
  results,
  operation,
  current,
  pat,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: SubscriptionQuery;
  current: number;
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
    { data: subscriptionData({ results, operation, current }), next: [] },
    { headers }
  );
};

/** Commit one bounded query and its metadata-only AuditLogEntry under the same live User authority. */
export const executeProtectedSubscriptionQuery = (input: QueryInput): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = currentMillis();
      const results = yield* Effect.tryPromise(() =>
        input.db.batch([...subscriptionStatements(input, current)])
      );
      return presentSubscription({
        results,
        operation: input.operation,
        current,
        pat: isPATCaller(input.subject),
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );
