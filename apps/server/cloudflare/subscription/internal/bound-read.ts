import { Effect } from "effect";
import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import {
  prepareSubscriptionOffers,
  prepareSubscriptionStatus,
} from "../../../src/shell/subscription/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import {
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";

export const prepareBoundSubscriptionRead =
  (
    operation: "subscription.listSubscriptionOffers" | "subscription.getSubscriptionStatus"
  ): CanonicalBrowserRead =>
  ({ db, authority, reservation, current }) => {
    const read =
      operation === "subscription.listSubscriptionOffers"
        ? prepareSubscriptionOffers(authority)
        : prepareSubscriptionStatus({ users: reservation, authority, current });
    return {
      statements: [
        ...read.statements.map(({ sql, params }) => db.prepare(sql).bind(...params)),
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          current,
          operation,
          outcome: "accepted",
          afterOwnerWrite: false,
        }),
        prepareReservedChangeCheck({ db, scope: "payment_authority", reservation }),
      ],
      present: (rows) =>
        Effect.try(() =>
          Response.json(
            { data: read.decode(rows.map((row) => row.results)), next: [] },
            { headers: transactionNoStore }
          )
        ).pipe(Effect.orElseSucceed(transactionUnavailable)),
    };
  };
