import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "../../../src/shell/browser-transport/contract";
import { BrowserSessionBinding } from "../../../src/shell/web-session/contract";
import { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import { prepareSelectedCurrentUser } from "../../../src/shell/identity/operations";
import { listCategoriesResponse } from "../../../src/shell/categories/operations";
import {
  decodeProcessingConsentStatusRead,
  prepareSelectedProcessingConsentRead,
} from "../../../src/shell/processing-consent/operations";
import { webSessionIdleRenewalCandidate } from "../../../src/core/web-session/operations";
import { TransactionListResponse } from "../../../src/shell/transactions/contract";
import { UserId } from "../../../src/core/identity/contract";
import { admitLocalRequest, noAuthority, rateLimited } from "../../canonical-admission/operations";
import { readLocalTransactionPage } from "../../transactions/operations";
import { newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { absentSessionResponse, sessionCookie, sessionDigest } from "../../web-session/operations";
import { WebSessionId } from "../../../src/core/web-session/contract";

const isResponse = Schema.is(Schema.instanceOf(Response));

const maximumInitialResponseBytes = 65536;

class SessionWriteUnavailable extends Data.TaggedError("SessionWriteUnavailable") {}

class IdentityAuditUnavailable extends Data.TaggedError("IdentityAuditUnavailable") {}

const json = <Body>(body: Body, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const initialPage = Effect.fn(function* (user: UserId, zone: string, now: number) {
  const local = DateTime.setZone(DateTime.makeUnsafe(now), DateTime.zoneMakeNamedUnsafe(zone));
  const from = DateTime.toUtc(DateTime.startOf(local, "month"));
  const to = DateTime.toUtc(DateTime.add(DateTime.startOf(local, "month"), { months: 1 }));
  const url = new URL("https://user.invalid/transactions");
  url.search = new URLSearchParams({
    from: DateTime.formatIso(from),
    to: DateTime.formatIso(to),
    limit: "25",
  }).toString();
  const result = yield* readLocalTransactionPage(new Request(url), user);

  return {
    from,
    to,
    page: yield* Schema.decodeUnknownEffect(TransactionListResponse)(result.body),
  };
});

const Session = Schema.Struct({ id: WebSessionId, user_id: UserId });

type Observation = Readonly<{ session: typeof Session.Type; url: URL; now: number }>;

const profileRead = Effect.fn(function* ({ session, now }: Observation) {
  const sql = yield* SqliteClient;

  const renewed =
    yield* sql`UPDATE web_sessions SET idle_expires_at_ms=min(hard_expires_at_ms,max(idle_expires_at_ms,${DateTime.toEpochMillis(webSessionIdleRenewalCandidate(DateTime.makeUnsafe(now)))})) WHERE id=${session.id} AND user_id=${session.user_id} AND revoked_at_ms IS NULL AND idle_expires_at_ms>${now} AND hard_expires_at_ms>${now} RETURNING id`;

  if (renewed.length !== 1) return yield* new SessionWriteUnavailable();

  const live =
    yield* sql`SELECT 1 FROM web_sessions WHERE id=${session.id} AND user_id=${session.user_id} AND revoked_at_ms IS NULL AND hard_expires_at_ms>${now} AND idle_expires_at_ms>${now} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (live.length !== 1) return noAuthority();
  const caller = { sql: "SELECT ? AS id,? AS userId", params: [session.id, session.user_id] };
  const query = prepareSelectedCurrentUser(caller);
  const user = yield* query.decode(yield* sql.unsafe(query.statement.sql, query.statement.params));
  const categories = yield* listCategoriesResponse;
  const profile = { ...user, categories: Option.some(categories.data) };

  const audit =
    yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,occurred_at_ms) VALUES(${newId()},${session.user_id},${session.id},'identity_read',${now}) RETURNING id`;

  if (audit.length !== 1) return yield* new IdentityAuditUnavailable();

  return profile;
});

const contextPage = Effect.fn(function* (
  { session, url, now }: Observation,
  profile: typeof CurrentUserMetadata.Type
) {
  const sql = yield* SqliteClient;
  const context = url.searchParams.get("context");

  const transactions =
    context === "transactions"
      ? Option.some(yield* initialPage(session.user_id, profile.data.timeZone, now))
      : Option.none();

  if (Option.isSome(transactions)) {
    const audit =
      yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms) VALUES(${newId()},${session.user_id},${session.id},'session_call','transactions.listTransactions','success',${now}) RETURNING id`;

    if (audit.length !== 1) return yield* new IdentityAuditUnavailable();
  }

  return transactions;
});

const observe = Effect.fn(function* (input: Observation) {
  const { session, url, now } = input;
  const sql = yield* SqliteClient;
  const binding = url.pathname === browserSessionBindingPath;

  if ((yield* admitLocalRequest({ user: session.user_id, current: now })).length === 0) {
    return rateLimited();
  }

  const caller = { sql: "SELECT ? AS id,? AS userId", params: [session.id, session.user_id] };
  const receipt = prepareSelectedProcessingConsentRead(caller);

  const consent = yield* decodeProcessingConsentStatusRead(
    yield* sql.unsafe(receipt.sql, receipt.params)
  );

  if (Option.isNone(consent)) return noAuthority();

  if (consent.value.status !== "Granted") {
    return binding
      ? json(
          yield* Schema.encodeEffect(BrowserSessionBinding)({
            binding: session.id,
            initial: Option.some(consent.value),
          })
        )
      : noAuthority();
  }

  const profile = yield* profileRead(input);

  if (isResponse(profile)) return profile;

  if (!binding) return json(yield* Schema.encodeEffect(CurrentUserMetadata)(profile));
  const transactions = yield* contextPage(input, profile);
  const initial = { ...consent.value, profile, transactions };

  const response = yield* Schema.encodeEffect(BrowserSessionBinding)({
    binding: session.id,
    initial: Option.some(initial),
  });

  if (
    new TextEncoder().encode(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(response)
    ).length <= maximumInitialResponseBytes
  ) {
    return json(response);
  }

  return json(
    yield* Schema.encodeEffect(BrowserSessionBinding)({
      binding: session.id,
      initial: Option.some({ ...initial, transactions: Option.none() }),
    })
  );
});

const bareBinding = (url: URL): boolean =>
  url.pathname === browserSessionBindingPath && !url.searchParams.has("context");

export const browserSessionRequest = Effect.fn(
  function* (request: Request, owns: (id: string) => boolean) {
    const url = new URL(request.url);
    const token = sessionCookie(request);

    if (Option.isNone(token)) return absentSessionResponse(url.pathname);
    const digest = yield* Effect.tryPromise(() => sessionDigest(token.value));
    const sql = yield* SqliteClient;

    return yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const [raw] =
        yield* sql`SELECT id,user_id FROM web_sessions WHERE token_digest=${digest} AND revoked_at_ms IS NULL AND hard_expires_at_ms>${now} AND idle_expires_at_ms>${now} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

      if (raw === undefined) return absentSessionResponse(url.pathname);
      const session = yield* Schema.decodeUnknownEffect(Session)(raw);

      if (!owns(session.user_id)) return absentSessionResponse(url.pathname);
      const expected = request.headers.get(browserSessionBindingHeader);

      if (expected !== session.id) return noAuthority();

      if (url.pathname === "/web/session/logout") {
        const revoked =
          yield* sql`UPDATE web_sessions SET revoked_at_ms=${now} WHERE id=${session.id} AND user_id=${session.user_id} AND revoked_at_ms IS NULL RETURNING id`;

        if (revoked.length !== 1) return yield* new SessionWriteUnavailable();

        return absentSessionResponse("/web/session/logout");
      }

      if (bareBinding(url)) return json({ binding: session.id });

      return yield* observe({ session, url, now });
    }).pipe(withStoreCapacity("required"));
  },
  Effect.catchCause(() => Effect.succeed(Response.json({ status: "unavailable" }, { status: 503 })))
);
