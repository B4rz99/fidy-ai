import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { PATScopes } from "../../src/core/tokens/contract";
import { type OAuthCaller, oauthResource } from "../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import { secretDigest } from "../secret-material/operations";

import type { OAuthRefreshAdmission, OAuthRevocationAdmission } from "./contract";
import { revokeConnections } from "./internal/revocation";
import {
  commitRotation,
  findGrant,
  invalidGrant,
  prepareIssuance,
  refreshCancelled,
  revokeReplay,
} from "./internal/refresh";
import { oauthResponse } from "./internal/response";
import { queryCallerSnapshot } from "./internal/query-caller";

/** Resolve live query capabilities and derived tier without publishing OAuth storage or changing accounting. Canonical owners still recheck authority in protected work. */
export const resolveOAuthQueryCaller: typeof queryCallerSnapshot = (input) =>
  queryCallerSnapshot(input);

/** Commits a still-live first-party decision under the original User coordinator. Cancelled or expired queued decisions cannot revoke later; a started atomic unit settles even if its response is lost. */
export const executeOAuthRevocation = (
  input: Readonly<{ db: D1Database; admission: OAuthRevocationAdmission; signal: AbortSignal }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || input.admission.deadlineAtMs <= current) {
      return oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 });
    }
    return yield* revokeConnections({
      db: input.db,
      current,
      connectionId: input.admission.connectionId,
      session: { id: input.admission.sessionId, user_id: input.admission.userId },
    });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 }))
    )
  );
/** Rotates under the original User coordinator without extending the grant. Recognized replay revokes the entire family, including a concurrent winner; delivery loss requires new browser approval. */
export const executeOAuthRefresh = (
  input: Readonly<{ db: D1Database; admission: OAuthRefreshAdmission; signal: AbortSignal }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const admittedAt = yield* Clock.currentTimeMillis;
    if (refreshCancelled({ input, current: admittedAt })) return invalidGrant();
    const grant = yield* findGrant({ input, current: admittedAt });
    if (Option.isSome(grant.consumed_at_ms)) {
      yield* revokeReplay({ input, current: yield* Clock.currentTimeMillis });
      return invalidGrant();
    }
    const approved = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(
      grant.scopes_json
    );
    const scopes = yield* Option.match(input.admission.scope, {
      onNone: () => Effect.succeed(approved),
      onSome: (scope) => Schema.decodeUnknownEffect(PATScopes)(scope.split(" ")),
    });
    if (!scopes.every((scope) => approved.includes(scope))) return invalidGrant();
    const current = yield* Clock.currentTimeMillis;
    const issuance = yield* prepareIssuance({ current, grant, scopes });
    if (refreshCancelled({ input, current: yield* Clock.currentTimeMillis })) return invalidGrant();
    const committed = yield* Effect.option(commitRotation({ input, grant, issuance }));
    if (Option.isNone(committed)) {
      // A failed CAS may be another instance's winner. Only a recognized consumed proof can revoke.
      yield* revokeReplay({ input, current: yield* Clock.currentTimeMillis }).pipe(Effect.ignore);
      return invalidGrant();
    }
    return oauthResponse({ body: issuance.body, status: 200 });
  }).pipe(Effect.catchCause(() => Effect.succeed(invalidGrant())));

/** Resolve admission facts only; protected work rechecks the same OAuth authority in its D1 unit. */
export const authenticateOAuth = (
  input: Readonly<{ request: Request; db: D1Database; current: number }>
): Effect.Effect<Option.Option<Readonly<{ subject: OAuthCaller; scopes: PATScopes }>>> =>
  Effect.gen(function* () {
    const bearer = Schema.decodeUnknownOption(
      Schema.String.check(Schema.isPattern(/^Bearer [A-Za-z0-9_-]{43}$/u))
    )(input.request.headers.get("authorization"));
    if (Option.isNone(bearer)) return Option.none();
    const digest = yield* secretDigest({
      purpose: "oauth-access",
      value: Redacted.make(bearer.value.slice("Bearer ".length)),
    });
    const found = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT a.id,a.connection_id,a.user_id,g.client_id,a.scopes_json
      FROM oauth_access_credentials a JOIN oauth_connections g ON g.id = a.connection_id WHERE a.digest = ?`)
        .bind(digest)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: OAuthCredentialId,
        connection_id: OAuthConnectionId,
        user_id: UserId,
        client_id: OAuthClientId,
        scopes_json: Schema.String,
      })
    )(found);
    const subject: OAuthCaller = {
      credentialId: row.id,
      oauthConnectionId: row.connection_id,
      userId: row.user_id,
      clientId: row.client_id,
      resource: oauthResource,
      digest,
      requiredScope: Option.none(),
    };
    const authority = liveOAuthAuthority({ subject, current: input.current });
    const live = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
        .bind(...authority.bindings)
        .first()
    );
    if (live === null) return Option.none();
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(row.scopes_json);
    return Option.some({ subject, scopes });
  }).pipe(Effect.catchCause(() => Effect.succeedNone));
