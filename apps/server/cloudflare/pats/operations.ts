import { browserSession } from "@fidy/server/web-session-runtime";
import { claimPATPairing } from "./internal/pat-claim";
import { approvePATPairing, inspectPATPairing, startPATPairing } from "./internal/pat-pairing";
import { createManualPAT, revokeAllPATs, revokePAT } from "./internal/pat-management";
import { matchesRoute } from "../routing/route-match";
import { HttpApi } from "effect/unstable/httpapi";
import { ActivePATList, PATPairingDirectGroup, PATsGroup } from "@fidy/server/tokens-contract";
import {
  expireApprovedPairings,
  expireFixedPATs,
  pairingExpiryCompletion,
  patExpiryCompletion,
  patMetadataQuery,
  patMetadataResponseFromRows,
  recordPATList,
  sweepPairingAdmission,
  sweepPairingReviews,
  sweepUnapprovedPairings,
} from "@fidy/server/tokens-operations";
import { expirePATConsents, expirePairingConsents } from "@fidy/server/consent-operations";
import { isConsentRevoked } from "../consent/operations";
import { prepareOwnedStatement } from "../atomic/operations";
import { currentMillis, newId } from "../platform/operations";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import {
  type CatalogOperation,
  decideOperationAccess,
  patScopeCapability,
} from "@fidy/server/canonical-runtime";
import type { CanonicalCapability } from "@fidy/server/canonical-runtime";
import { type Cause, Effect, Option, Schema } from "effect";
import {
  PATRow,
  canonical,
  digest,
  equalsDigest,
  httpRateLimited,
  response,
  scopesFrom,
  shortLength,
  unauthorized,
  serviceUnavailable as unavailable,
  validBearer,
} from "./internal/pat-shared";

const StoredPAT = Schema.Struct({ ...PATRow.fields, bearer_digest: Schema.Array(Schema.Int) });
const authenticate = (
  request: Request,
  db: D1Database
): Effect.Effect<Option.Option<typeof StoredPAT.Type>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return Option.none();
    const bearer = authorization.slice("Bearer ".length);
    if (!validBearer(bearer)) return Option.none();
    const shortId = bearer.slice("fin_".length, "fin_".length + shortLength);
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id,user_id,short_id,recipient_label,scopes_json,lifetime_days,
    created_at_ms,expires_at_ms,last_used_at_ms,revoked_at_ms,bearer_digest FROM pats WHERE short_id = ?`)
        .bind(shortId)
        .first()
    );
    const pat = Schema.decodeUnknownOption(StoredPAT)(raw);
    if (Option.isNone(pat)) return Option.none();
    if (pat.value.revoked_at_ms !== null || pat.value.expires_at_ms <= currentMillis()) {
      return Option.none();
    }
    const candidate = yield* Effect.tryPromise(() => digest(bearer));
    return equalsDigest({ stored: pat.value.bearer_digest, candidate }) ? pat : Option.none();
  });
type CategoryAuthorization =
  | "accepted"
  | "unauthenticated"
  | "scope_missing"
  | "user_action_required";
export type AuthorizedPAT = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
const scopeDecision = (
  scopes: ReturnType<typeof scopesFrom>,
  operation: CatalogOperation
): CategoryAuthorization => {
  if (Option.isNone(scopes)) return "unauthenticated";
  const access = decideOperationAccess(operation.policy.access, {
    _tag: "PAT",
    capabilities: scopes.value,
  });
  if (access._tag === "Allowed") return "accepted";
  return access.reason === "pat_scope_missing" ? "scope_missing" : "unauthenticated";
};
/** Every declared operation uses the same bearer, subject, expiry and policy decision. */
export const authorizeCanonicalPAT = ({
  request,
  db,
  operation,
}: Readonly<{ request: Request; db: D1Database; operation: CatalogOperation }>): Promise<
  AuthorizedPAT | Exclude<CategoryAuthorization, "accepted">
> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pat = yield* authenticate(request, db);
      if (Option.isNone(pat)) return "unauthenticated";
      if (yield* isConsentRevoked({ db, userId: pat.value.user_id })) return "user_action_required";
      const decision = scopeDecision(scopesFrom(pat.value.scopes_json), operation);
      return decision === "accepted"
        ? {
            patId: pat.value.id,
            userId: pat.value.user_id,
            digest: new Uint8Array(pat.value.bearer_digest),
            requiredScope: patScopeCapability(operation.policy.access),
          }
        : decision;
    })
  );

/** List only currently active, subject-owned, safe PAT metadata. */
export const listPATs = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() =>
        browserSession({ request, db, input: { current: currentMillis(), fresh: false } })
      );
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      return yield* Effect.gen(function* () {
        const [rows, recorded] = yield* Effect.tryPromise({
          try: () =>
            db.batch([
              prepareOwnedStatement({
                db,
                statement: patMetadataQuery({ userId: session.value.userId, current, session }),
              }),
              prepareOwnedStatement({
                db,
                statement: recordPATList({
                  session: session.value,
                  input: { id: newId(), current },
                }),
              }),
            ]),
          catch: (error) =>
            refusedByAuditBudget(error) ? ("rate_limited" as const) : ("unavailable" as const),
        });
        if (recorded?.meta.changes !== 1) return unauthorized();
        if (rows === undefined) return unavailable();
        const listed = yield* patMetadataResponseFromRows(rows.results).pipe(Effect.option);
        return Option.isSome(listed)
          ? canonical(
              yield* Schema.encodeEffect(Schema.toCodecJson(ActivePATList))(listed.value.data)
            )
          : unavailable();
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error === "rate_limited"
              ? response({
                  body: {
                    error: { code: "rate_limited", message: "PAT metadata budget exhausted." },
                    next: [],
                  },
                  status: httpRateLimited,
                })
              : unavailable()
          )
        )
      );
    })
  );

type PATHandler = (
  input: Readonly<{ request: Request; db: D1Database; path: string }>
) => Promise<Response>;
type OperationName =
  | keyof typeof PATPairingDirectGroup.endpoints
  | keyof typeof PATsGroup.endpoints;
const handlers = {
  start: startPATPairing,
  claim: claimPATPairing,
  inspectPATPairing,
  approvePATPairing,
  listPATs,
  createManualPAT,
  revokeAllPATs,
  revokePAT: ({ request, db, path }): Promise<Response> =>
    revokePAT({ request, db, shortId: path.split("/").at(-1) ?? "" }),
} satisfies Record<OperationName, PATHandler>;
const handlersByName: ReadonlyMap<string, PATHandler> = new Map(Object.entries(handlers));

const declared = HttpApi.make("patWorker").add(PATPairingDirectGroup).add(PATsGroup);
type Route = Readonly<{
  group: string;
  name: string;
  method: string;
  template: string;
}>;
const routes: Array<Route> = [];
HttpApi.reflect(declared, {
  onGroup: () => {},
  onEndpoint: ({ endpoint, group }) => {
    if (!handlersByName.has(endpoint.identifier)) throw new Error("Unimplemented PAT operation");
    routes.push({
      group: group.identifier,
      name: endpoint.identifier,
      method: endpoint.method,
      template: endpoint.path,
    });
  },
});
const forPath = (path: string): ReadonlyArray<Route> =>
  routes.filter((route) => matchesRoute(route.template, path));
/** PAT paths derive from the declared direct bootstrap and canonical operation groups. */
export const patRoute = (path: string): boolean => forPath(path).length > 0;
export const patDirectRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATPairingDirectGroup.identifier);
export const patBrowserRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATsGroup.identifier);
export const patMethods = (path: string): ReadonlyArray<string> =>
  Array.from(new Set(forPath(path).map((route) => route.method)));
/** Execute only a declared PAT operation, never a guessed path or method. */
export const handlePATRequest = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const route = forPath(path).find((candidate) => candidate.method === request.method);
  const handler = route === undefined ? undefined : handlersByName.get(route.name);
  return handler === undefined
    ? Promise.resolve(Response.json({ status: "method_not_allowed" }, { status: 405 }))
    : handler({ request, db, path });
};

const scheduledSweepLimit = 4000;
/** Reclaim unapproved anonymous metadata; never remove approved User-bound grant evidence. */
export const sweepExpiredPATPairings = (db: D1Database): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = currentMillis();
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareOwnedStatement({
            db,
            statement: expirePairingConsents({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({ db, statement: expireApprovedPairings(current) }),
          db.prepare(pairingExpiryCompletion).bind(current),
          prepareOwnedStatement({
            db,
            statement: expirePATConsents({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({ db, statement: expireFixedPATs(current) }),
          db.prepare(patExpiryCompletion).bind(current),
          prepareOwnedStatement({
            db,
            statement: sweepUnapprovedPairings({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({
            db,
            statement: sweepPairingAdmission({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({
            db,
            statement: sweepPairingReviews({ current, limit: scheduledSweepLimit }),
          }),
        ])
      );
    })
  );
