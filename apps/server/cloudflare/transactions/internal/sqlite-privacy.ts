import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { UserId, UserPreferences } from "../../../src/core/identity/contract";
import { PrivacyTransactionRequest } from "../../../src/shell/processing-consent/contract";
import { listCategoriesResponse } from "../../../src/shell/categories/operations";
import {
  admitLocalRequest,
  canonicalAdmissionUnavailable,
  noAuthority,
  rateLimited,
} from "../../canonical-admission/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { understoodCategory } from "./sqlite-history";
import { invalid, localHistoryPage, presentPrivacyPage, privacyQuery } from "./transaction-history";

class PrivacyUnavailable extends Data.TaggedError("PrivacyUnavailable") {}

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const freshOwner = Effect.fnUntraced(function* (binding: string, digest: Uint8Array) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`SELECT user_id FROM web_sessions WHERE id=${binding} AND token_digest=${digest} AND revoked_at_ms IS NULL AND fresh_until_ms>${current} AND idle_expires_at_ms>${current} AND hard_expires_at_ms>${current} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  return Schema.decodeUnknownOption(UserId)(row?.user_id);
});

const materializePage = Effect.fnUntraced(function* (
  user: UserId,
  body: typeof PrivacyTransactionRequest.Type,
  reference: string
) {
  const sql = yield* SqliteClient;
  const page = localHistoryPage({ user, query: yield* privacyQuery(body) });
  const rows = yield* sql.unsafe(page.sql, page.bindings);

  if (!rows.every(understoodCategory)) return yield* new PrivacyUnavailable();
  const [settings] = yield* sql`SELECT locale,time_zone AS timeZone FROM users WHERE id=${user}`;
  const presentation = yield* Schema.decodeUnknownEffect(UserPreferences)(settings);
  const categories = yield* listCategoriesResponse;

  const response = yield* presentPrivacyPage({
    rows,
    reference,
    display: {
      presentation,
      categories: categories.data,
    },
  });

  if (!response.ok) return yield* new PrivacyUnavailable();

  return response;
});

const auditedPrivacyPage = Effect.fnUntraced(function* ({
  binding,
  digest,
  body,
  owns,
}: Readonly<{
  binding: string;
  digest: Uint8Array;
  body: typeof PrivacyTransactionRequest.Type;
  owns: (user: string) => boolean;
}>) {
  const subject = yield* freshOwner(binding, digest);

  if (Option.isNone(subject) || !owns(subject.value)) return noAuthority();
  const user = subject.value;
  const current = yield* Clock.currentTimeMillis;
  const admitted = yield* admitLocalRequest({ user, current });

  if (admitted.length !== 1) return rateLimited();
  const reference = newId();
  const response = yield* materializePage(user, body, reference);
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const audit =
    yield* sql`INSERT INTO audit_entries(id,user_id,record_type,session_id,operation,outcome,occurred_at_ms) SELECT ${reference},${user},'session_call',${binding},'privacy.transactions','success',${now} FROM web_sessions WHERE id=${binding} AND user_id=${user} AND fresh_until_ms>${now} AND idle_expires_at_ms>${now} AND hard_expires_at_ms>${now} AND revoked_at_ms IS NULL AND token_digest=${digest} AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING id`;

  return audit.length === 1 ? response : noAuthority();
});

export const readPrivacyPage = Effect.fn(
  function* (request: Request, origin: string, owns: (user: string) => boolean) {
    if (request.headers.get("origin") !== origin) {
      return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
    }

    if (request.headers.has("authorization")) return noAuthority();

    if (new URL(request.url).search !== "") return invalid();
    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return noAuthority();
    const raw = yield* boundedJsonBody({ request, policy: bodyPolicy, schema: Schema.Unknown });

    const body = Option.flatMap(
      raw,
      Schema.decodeUnknownOption(PrivacyTransactionRequest, { onExcessProperty: "error" })
    );

    if (Option.isNone(body)) return invalid();

    return yield* auditedPrivacyPage({ ...proof.value, body: body.value, owns }).pipe(
      withStoreCapacity("required")
    );
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);
