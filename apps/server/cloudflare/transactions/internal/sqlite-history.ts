import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option } from "effect";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import {
  attachCanonicalStanding,
  noAuthority,
  rateLimited,
} from "../../canonical-admission/operations";
import { canonicalRequestProtection } from "../../canonical-admission/contract";
import { decodeQuotaStatus, quotaStatusSelection } from "../../quotas/operations";
import { newId } from "../../secret-material/operations";
import {
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { invalid, parseQuery, presentHistory, selectedHistoryPage } from "./transaction-history";

class HistoryUnavailable extends Data.TaggedError("HistoryUnavailable") {}

const admitBrowserRead = Effect.fn(function* ({
  user,
  current,
}: Readonly<{ user: string; current: number }>) {
  const sql = yield* SqliteClient;
  const policy = canonicalRequestProtection;
  yield* sql`DELETE FROM canonical_request_leases WHERE user_id=${user} AND expires_at_ms<=${current}`;
  return yield* sql`INSERT INTO canonical_request_buckets(subject,virtual_at_ms)
      SELECT ${"user:" + user},${current + policy.intervalMs}
      WHERE (SELECT count(*) FROM canonical_request_leases WHERE user_id=${user}) < ${policy.concurrency}
      ON CONFLICT(subject) DO UPDATE SET virtual_at_ms=max(virtual_at_ms,${current})+${policy.intervalMs}
      WHERE virtual_at_ms<=${current + (policy.burst - 1) * policy.intervalMs} RETURNING 1`;
});

/** A bound browser read is unmetered. Materialize its complete response, standing and Audit together. */
export const readUserHistory = Effect.fn(function* (
  request: Request,
  owns: (userId: string) => boolean
) {
  const sql = yield* SqliteClient;
  const prepared = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));
  if (Option.isNone(prepared)) return noAuthority();
  // Hashing the cookie can yield. Build the final expiry predicates at the transaction's decision instant.
  const selection = { request, search: false, id: Option.none<string>() } as const;
  const query = parseQuery(selection);
  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const lookup = boundSessionLookup({ ...prepared.value, current });
    const { statement, authority } = lookup;
    const [row] = yield* sql.unsafe(statement.sql, statement.params);
    const subject = Option.filter(resolveBoundCanonicalWebSession({ lookup, row }), (caller) =>
      owns(caller.userId)
    );
    if (Option.isNone(subject)) return noAuthority();
    const user = subject.value.userId;
    const users = { sql: "SELECT ? AS userId", params: [user] };
    const standing = quotaStatusSelection({ users, current });
    const [statusRow] = yield* sql.unsafe(standing.sql, standing.params);
    const status = decodeQuotaStatus({ row: statusRow, current });
    if (Option.isNone(status)) return yield* new HistoryUnavailable();
    const admitted = yield* admitBrowserRead({ user, current });
    if (admitted.length !== 1) {
      return attachCanonicalStanding({ response: rateLimited(), status: status.value, current });
    }
    let response = invalid();
    if (Option.isSome(query)) {
      const page = selectedHistoryPage({ authority, query: query.value, userSelection: users });
      const rows = yield* sql.unsafe(page.sql, page.bindings);
      response = presentHistory({ rows: { results: rows }, query: query.value, selection });
      if (!response.ok) return yield* new HistoryUnavailable();
    }
    const audit = recordAuthorizedCall({
      authority,
      id: newId(),
      current,
      operation: "transactions.listTransactions",
      outcome: response.ok ? "success" : "validation_failed",
      afterOwnerWrite: false,
    });
    const audited = yield* sql.unsafe(audit.sql + " RETURNING id", audit.params);
    if (audited.length !== 1) return yield* new HistoryUnavailable();
    return attachCanonicalStanding({ response, status: status.value, current });
  }).pipe(withStoreCapacity("required"));
});
