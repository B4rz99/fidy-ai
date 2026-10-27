import { Effect, Option, Schema } from "effect";
import { Account } from "../../../src/core/connections/contract";
import { prepareAuditQueryCall } from "../../../src/shell/audit/operations";
import { recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { commitPATUnit } from "../../tokens/operations";

const maximumAccounts = 1000;
const connectionPathOffset = -2;
export const browseAccounts = (
  input: Readonly<{ db: D1Database; subject: QueryCaller; request: Request; current: number }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { db, subject, current } = input;
    const authority = callerAuthority(input);
    const connectionId =
      new URL(input.request.url).pathname.split("/").at(connectionPathOffset) ?? "";
    const gate = `EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`;
    const results = yield* Effect.tryPromise(() =>
      commitPATUnit({
        db,
        statements: [
          db
            .prepare(`SELECT id FROM connections WHERE id=? AND user_id=? AND ${gate}`)
            .bind(connectionId, subject.userId, ...authority.bindings),
          db
            .prepare(`SELECT r.id,r.connection_id AS connectionId FROM connection_accounts r JOIN connections c ON c.id=r.connection_id
      JOIN connection_grants g ON g.attempt_id=r.grant_attempt_id
      WHERE c.id=? AND c.user_id=? AND c.state='Active' AND g.state='active' AND ${gate} ORDER BY r.id LIMIT ?`)
            .bind(connectionId, subject.userId, ...authority.bindings, maximumAccounts),
          ...(isPATCaller(subject)
            ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
                db.prepare(sql).bind(...params)
              )
            : []),
          prepareAuditQueryCall({
            db,
            authority,
            id: transactionId(),
            operation: "connections.listAccounts",
            current,
            missingWhen: {
              sql: "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM connections WHERE id=? AND user_id=?)",
              params: [connectionId, subject.userId],
            },
          }),
        ],
      })
    );
    const connections = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ id: Schema.String }))
    )(results[0]?.results);
    if (Option.isNone(Option.fromUndefinedOr(connections[0]))) {
      return transactionFailure({
        code: "not_found",
        status: 404,
        message: "Connection unavailable.",
      });
    }
    const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(Account))(results[1]?.results);
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(Account)))(accounts);
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
