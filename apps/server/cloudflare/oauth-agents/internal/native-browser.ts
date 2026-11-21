import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import { OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import { UserId } from "../../../src/core/identity/contract";
import {
  isReviewedOAuthExpiration,
  oauthAuthorizationCodeExpiresAt,
} from "../../../src/core/oauth-agents/operations";
import { grantOAuthConsent } from "../../../src/shell/consent/operations";
import { OAuthConnected, oauthIssuer, oauthPaths } from "../../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import {
  boundSecuritySessionLookup,
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { newId, newSecret, secretDigest } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { BootstrapUnavailable } from "../contract";
import { projectReview, readReference } from "./review";
import { grantStatement } from "./approval";
import { invalidRequest, isResponse, requestedScopes } from "./bootstrap";
import { oauthResponse } from "./response";
import { type Directory, FrozenReview, register } from "./native-registration";

import { admitUserOAuth } from "./native-admission";

type Proof = Awaited<ReturnType<typeof readBoundWebSessionProof>>;

export const oauthSession = Effect.fn(function* ({
  proof,
  owns,
  fresh,
  requireConsent,
}: {
  proof: Proof;
  owns: (id: string) => boolean;
  fresh: boolean;
  requireConsent: boolean;
}) {
  if (Option.isNone(proof)) return Option.none<{ id: string; user_id: UserId }>();
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const lookup = (requireConsent ? boundSessionLookup : boundSecuritySessionLookup)({
    ...proof.value,
    current,
  });

  const [row] = yield* sql.unsafe(
    lookup.statement.sql +
      " AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=web_sessions.user_id)" +
      (fresh ? " AND fresh_until_ms>?" : ""),
    fresh ? [...lookup.statement.params, current] : lookup.statement.params
  );

  const session = resolveBoundCanonicalWebSession({ lookup, row });

  if (Option.isNone(session) || !owns(session.value.userId)) {
    return Option.none<{ id: string; user_id: UserId }>();
  }

  return Option.some({
    id: session.value.id,
    user_id: yield* Schema.decodeEffect(UserId)(session.value.userId),
  });
});

const denied = (): Response => oauthResponse({ body: { error: "unauthenticated" }, status: 401 });

type BrowserInput = {
  request: Request;
  directory: Directory;
  owns: (id: string) => boolean;
  origin: string;
};

const prepareBrowser = Effect.fn(function* (input: BrowserInput) {
  if (input.request.headers.get("origin") !== input.origin) {
    return oauthResponse({ body: { error: "forbidden_origin" }, status: 403 });
  }

  const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(input.request));

  const session = yield* oauthSession({
    proof,
    owns: input.owns,
    fresh: true,
    requireConsent: true,
  });

  if (Option.isNone(session)) return denied();

  if (!(yield* admitUserOAuth.pipe(withStoreCapacity("growth")))) {
    return oauthResponse({ body: { error: "slow_down" }, status: 429 });
  }

  const url = new URL(input.request.url),
    query = url.searchParams;

  if (new Set(query.keys()).size !== Array.from(query.keys()).length) return invalidRequest();
  const choice = yield* readReference(input.request);
  const user = session.value.user_id;

  const frozen = yield* register(
    input.directory,
    { action: "bind", user, requestId: choice.requestId },
    FrozenReview
  );

  if (Option.isNone(frozen)) return invalidRequest();
  const { request_json: pending, metadata_json: client, expires_at_ms: deadline } = frozen.value;

  const finish = register(
    input.directory,
    { action: "finish", user, requestId: choice.requestId },
    Schema.Boolean
  ).pipe(Effect.tapError(Effect.logDebug), Effect.ignore);

  const scopes = requestedScopes(Option.fromUndefinedOr(pending.scope));

  if (Option.isNone(scopes)) return invalidRequest();
  const active = activeReview({ proof, owns: input.owns, user, deadline, choice, pending });

  return {
    url,
    choice,
    user,
    session: session.value,
    active,
    finish,
    scopes: scopes.value,
    client,
    pending,
    deadline,
  };
});

const activeReview = Effect.fn(function* ({
  proof,
  owns,
  user,
  deadline,
  choice,
  pending,
}: {
  proof: Proof;
  owns: BrowserInput["owns"];
  user: UserId;
  deadline: number;
  choice: Effect.Success<ReturnType<typeof readReference>>;
  pending: (typeof FrozenReview.Type)["request_json"];
}) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const live = yield* oauthSession({
    proof,
    owns,
    fresh: true,
    requireConsent: true,
  });

  if (Option.isNone(live) || live.value.user_id !== user || deadline <= current) return false;
  yield* sql`INSERT INTO oauth_review_requests(id,client_id,user_id,state,expires_at_ms) VALUES(${choice.requestId},${pending.client_id},${user},'pending',${deadline}) ON CONFLICT(id) DO NOTHING`;

  return (
    (yield* sql`SELECT 1 FROM oauth_review_requests WHERE id=${choice.requestId} AND user_id=${user} AND state='pending' AND expires_at_ms>${current}`)
      .length === 1
  );
});

type ReviewContext = Exclude<Effect.Success<ReturnType<typeof prepareBrowser>>, Response>;

const inspectReview = Effect.fn(function* ({
  url,
  choice,
  active,
  finish,
  pending,
  client,
  deadline,
  scopes,
}: ReviewContext) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    if (!(yield* active)) return invalidRequest();

    if (url.pathname === oauthPaths.cancel) {
      yield* sql`UPDATE oauth_review_requests SET state='cancelled' WHERE id=${choice.requestId}`;

      return oauthResponse({ body: { cancelled: true }, status: 200 });
    }

    return yield* projectReview({
      row: {
        request_json: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(pending),
        metadata_json: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(client),
        expires_at_ms: DateTime.makeUnsafe(deadline),
      },
      requestId: choice.requestId,
      scopes,
      current: yield* Clock.currentTimeMillis,
    });
  }).pipe(
    withStoreCapacity("growth"),
    Effect.tap((response) =>
      url.pathname === oauthPaths.cancel && response.ok ? finish : Effect.void
    )
  );
});

type ApprovedChoice = Extract<ReviewContext["choice"], { scopes: unknown }>;

const reserveGrant = Effect.fn(function* ({
  directory,
  user,
  choice,
  active,
}: {
  directory: Directory;
  user: UserId;
  choice: ApprovedChoice;
  active: ReviewContext["active"];
}) {
  const current = yield* Clock.currentTimeMillis;
  const expiresAt = DateTime.toEpochMillis(choice.expiresAt);

  const reviewed = (time: number): boolean =>
    isReviewedOAuthExpiration({
      current: time,
      reviewedAt: DateTime.toEpochMillis(choice.reviewedAt),
      expiresAt,
      lifetimeDays: choice.lifetimeDays,
    });

  if (!reviewed(current) || !(yield* active.pipe(withStoreCapacity("growth")))) {
    return invalidRequest();
  }

  const connectionId = OAuthConnectionId.make(newId()),
    code = yield* newSecret;

  const digest = yield* secretDigest({ purpose: "oauth-code", value: code });
  const codeExpires = oauthAuthorizationCodeExpiresAt(current);

  const route = yield* register(
    directory,
    {
      action: "reserve",
      user,
      connection: connectionId,
      operation: choice.requestId,
      routes: [
        { kind: "code", digest: Hex.encode(digest), record: connectionId, expires: codeExpires },
      ],
    },
    Schema.Boolean
  );

  if (Option.isNone(route)) return yield* new BootstrapUnavailable({ cause: Option.none() });
  const scopesJson = yield* Schema.encodeEffect(Schema.fromJsonString(PATScopes))(choice.scopes);

  return { connectionId, code, digest, codeExpires, reviewed, expiresAt, scopesJson };
});

const connectReview = Effect.fn(function* (
  review: ReviewContext,
  choice: ApprovedChoice,
  directory: Directory
) {
  const { user, session, active, finish, pending, client } = review;
  const reserved = yield* reserveGrant({ directory, user, choice, active });

  if (isResponse(reserved)) return reserved;
  const { connectionId, code, digest, codeExpires, reviewed, expiresAt, scopesJson } = reserved;
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (!reviewed(now) || codeExpires <= now || !(yield* active)) return invalidRequest();

    const add = grantStatement({
      input: { current: now, session, pending, client, choice },
      material: { connectionId, scopesJson, expiresAt, digest },
    });

    if ((yield* sql.unsafe(add.sql + " RETURNING id", add.params)).length !== 1) {
      return invalidRequest();
    }

    const evidence = grantOAuthConsent({
      id: newId(),
      connectionId,
      session,
      current: now,
      scopes: choice.scopes,
      expiresAt,
    });

    if ((yield* sql.unsafe(evidence.sql + " RETURNING id", evidence.params)).length !== 1) {
      return yield* new BootstrapUnavailable({ cause: Option.none() });
    }

    yield* sql`UPDATE oauth_connections SET code_digest=${digest},code_challenge=${pending.code_challenge},code_expires_at_ms=${codeExpires} WHERE id=${connectionId}`;
    yield* sql`UPDATE oauth_review_requests SET state='connected' WHERE id=${choice.requestId}`;
    const callback = new URL(pending.redirect_uri);
    callback.searchParams.set("code", Redacted.value(code));
    callback.searchParams.set("iss", oauthIssuer);

    if (pending.state !== undefined) callback.searchParams.set("state", pending.state);

    return oauthResponse({
      body: yield* Schema.encodeEffect(OAuthConnected)({ connectionId, callback: callback.href }),
      status: 200,
    });
  }).pipe(
    withStoreCapacity("growth"),
    Effect.tap((response) => (response.ok ? finish : Effect.void))
  );
});

export const nativeOAuthBrowser = Effect.fn(
  function* (input: BrowserInput) {
    const context = yield* prepareBrowser(input);

    if (isResponse(context)) return context;

    if (context.url.pathname === oauthPaths.review || context.url.pathname === oauthPaths.cancel) {
      return yield* inspectReview(context);
    }

    const { choice, scopes } = context;

    if (!("scopes" in choice) || !choice.scopes.every((scope) => scopes.includes(scope))) {
      return invalidRequest();
    }

    return yield* connectReview(context, choice, input.directory);
  },
  Effect.tapError(Effect.logDebug),
  Effect.catchTags({
    BootstrapInvalid: () => Effect.succeed(invalidRequest()),
    SchemaError: () => Effect.succeed(invalidRequest()),
  }),
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() =>
    Effect.succeed(oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 }))
  )
);
