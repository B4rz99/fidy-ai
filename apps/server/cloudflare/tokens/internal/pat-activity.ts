import { Clock, Effect, Option, Schema } from "effect";
import { PATActivity } from "../../../src/shell/tokens/contract";
import { TokenShortId } from "../../../src/core/tokens/contract";
import { preparePATActivityMetadata } from "../../../src/shell/tokens/operations";
import {
  preparePATActivity,
  recordPATActivityQuery,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { newId } from "../../secret-material/operations";
import type { PATActivityRead, PATMetadataQuery } from "../contract";
import { canonical, notFound, response, serviceUnavailable, unauthorized } from "./pat-shared";

export const getActivity = (
  input: PATMetadataQuery & Readonly<{ shortId: string }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if ("patId" in input.subject) return unauthorized();
    const current = yield* Clock.currentTimeMillis;
    return yield* getHeldActivity({
      db: input.db,
      userId: input.subject.userId,
      shortId: input.shortId,
      current,
      authority: liveWebSessionAuthority({ subject: input.subject, current }),
    });
  });

export const getHeldActivity = ({ db, ...read }: PATActivityRead): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const selected = Schema.decodeOption(TokenShortId)(read.shortId);
    if (Option.isNone(selected)) return notFound();
    const input = {
      ...read,
      shortId: selected.value,
      authority: {
        ...read.authority,
        predicate: `(${read.authority.predicate}) AND user_id = ?`,
        bindings: [...read.authority.bindings, read.userId],
      },
    };
    const metadata = preparePATActivityMetadata(input);
    const activity = preparePATActivity(input);
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          prepareOwnedStatement({ db, statement: metadata.statement }),
          prepareOwnedStatement({ db, statement: activity.statement }),
          prepareOwnedStatement({
            db,
            statement: recordPATActivityQuery({ ...input, id: newId() }),
          }),
        ]),
      catch: (error) =>
        refusedByAuditBudget(error) ? ("rate_limited" as const) : ("unavailable" as const),
    });
    if (results[2]?.meta.changes !== 1) return unauthorized();
    const pat = yield* metadata.decode(results[0]?.results);
    if (Option.isNone(pat)) return notFound();
    const history = yield* activity.decode(results[1]?.results);
    return canonical(
      yield* Schema.encodeEffect(Schema.toCodecJson(PATActivity))({ pat: pat.value, ...history })
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error === "rate_limited"
          ? response({
              status: 429,
              body: {
                error: { code: "rate_limited", message: "PAT activity budget exhausted." },
                next: [],
              },
            })
          : serviceUnavailable()
      )
    )
  );
