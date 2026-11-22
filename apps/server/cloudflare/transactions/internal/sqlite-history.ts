import type { UserId } from "../../../src/core/identity/contract";
import { TransactionListResponse } from "../../../src/shell/transactions/contract";
import { localTransactionRefusal } from "./sqlite-capture";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { CategoryReference } from "../../../src/core/categories/contract";
import { currentCategoryRelease, interpretCategory } from "../../../src/core/categories/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import type { LocalMutationResult } from "../../canonical-admission/contract";
import {
  admitLocalRequest,
  attachCanonicalStanding,
  canonicalAdmissionUnavailable,
  noAuthority,
  rateLimited,
} from "../../canonical-admission/operations";

import { decodeQuotaStatus, quotaStatusSelection } from "../../quotas/operations";
import { newId } from "../../secret-material/operations";
import {
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import {
  decodeLocalHistoryPage,
  invalid,
  localHistoryPage,
  parseQuery,
  presentHistory,
  selectedHistoryPage,
} from "./transaction-history";

const HistoryCategoryReference = Schema.Struct({
  category_revision: CategoryReference.fields.revision,
  category_id: CategoryReference.fields.categoryId,
});

export const understoodCategory = (row: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(HistoryCategoryReference)(row).pipe(
      Option.flatMap(({ category_revision: revision, category_id: categoryId }) =>
        interpretCategory({ release: currentCategoryRelease, reference: { revision, categoryId } })
      )
    )
  );

const presentRetainedHistory = (input: Parameters<typeof presentHistory>[0]): Response =>
  input.rows.results.every(understoodCategory)
    ? presentHistory(input)
    : canonicalAdmissionUnavailable();

class HistoryUnavailable extends Data.TaggedError("HistoryUnavailable") {}

export const readUserHistory = Effect.fn(function* (
  request: Request,
  owns: (userId: string) => boolean
) {
  const sql = yield* SqliteClient;
  const prepared = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

  if (Option.isNone(prepared)) return noAuthority();
  const search = new URL(request.url).pathname === "/transactions/search";
  const operation = search ? "transactions.searchTransactions" : "transactions.listTransactions";
  const selection = { request, search, id: Option.none<string>() } as const;
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
    const admitted = yield* admitLocalRequest({ user, current });

    if (admitted.length !== 1) {
      return attachCanonicalStanding({ response: rateLimited(), status: status.value, current });
    }

    let response = invalid();

    if (Option.isSome(query)) {
      const page = selectedHistoryPage({ authority, query: query.value, userSelection: users });
      const rows = yield* sql.unsafe(page.sql, page.bindings);
      response = presentRetainedHistory({
        rows: { results: rows },
        query: query.value,
        selection,
      });

      if (!response.ok) return yield* new HistoryUnavailable();
    }

    const audit = recordAuthorizedCall({
      authority,
      id: newId(),
      current,
      operation,
      outcome: response.ok ? "success" : "validation_failed",
      afterOwnerWrite: false,
    });

    const audited = yield* sql.unsafe(audit.sql + " RETURNING id", audit.params);

    if (audited.length !== 1) return yield* new HistoryUnavailable();

    return attachCanonicalStanding({ response, status: status.value, current });
  }).pipe(withStoreCapacity("required"));
});

export const readLocalTransactionPage = Effect.fn(function* (request: Request, user: UserId) {
  const selection = {
    request,
    search: new URL(request.url).pathname === "/transactions/search",
    id: Option.none<string>(),
  };

  const query = parseQuery(selection);

  if (Option.isNone(query)) {
    return yield* localTransactionRefusal({
      status: 400,
      message: "Invalid Transaction history query.",
    });
  }

  const sql = yield* SqliteClient;
  const page = localHistoryPage({ user, query: query.value });
  const rows = yield* sql.unsafe(page.sql, page.bindings);

  if (!rows.every(understoodCategory)) return yield* new HistoryUnavailable();

  const records = yield* Effect.fromOption(
    decodeLocalHistoryPage({ rows, selection, query: query.value }),
    () => new HistoryUnavailable()
  );

  return {
    status: 200,
    outcome: "success" as const,
    body: yield* Schema.encodeEffect(Schema.toCodecJson(TransactionListResponse))(records),
  } satisfies LocalMutationResult;
});
