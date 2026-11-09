import { Effect, Schema } from "effect";
import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import { preparePATMetadata } from "../../../src/shell/tokens/operations";
import { recordPATList } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import { ActivePATList } from "../../../src/core/tokens/contract";
import {
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";

export const prepareBoundPATList: CanonicalBrowserRead = ({
  db,
  authority,
  reservation,
  current,
}) => {
  const metadata = preparePATMetadata({ users: reservation, authority, current });
  const audit = recordPATList({ authority, input: { id: transactionId(), current } });
  return {
    statements: [
      db.prepare(metadata.statement.sql).bind(...metadata.statement.params),
      db.prepare(audit.sql).bind(...audit.params),
      prepareReservedChangeCheck({ db, scope: "pat_atomic", reservation }),
    ],
    present: (rows) =>
      metadata.decode(rows[0]?.results ?? []).pipe(
        Effect.flatMap(({ data }) => Schema.encodeEffect(Schema.toCodecJson(ActivePATList))(data)),
        Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
        Effect.orElseSucceed(transactionUnavailable)
      ),
  };
};
