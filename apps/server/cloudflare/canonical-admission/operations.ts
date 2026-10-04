import { Clock, DateTime, Effect, Option, Schema } from "effect";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import type { AuditAuthority } from "../../src/shell/audit/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { CanonicalCapability } from "../../src/core/canonical-operations/contract";
import { livePATCredential, recordProtectedPATUse } from "../../src/shell/tokens/operations";
import { liveWebSessionAuthority } from "../../src/shell/identity/operations";
import {
  prepareAuthorizedAuditCall,
  prepareCanonicalAdmissionRefusal,
} from "../../src/shell/audit/operations";
import { CanonicalRetryKey, QuotaStatus } from "../../src/core/quotas/contract";
import { allowancePeriod } from "../../src/core/quotas/operations";
import {
  decodeQuotaStatus,
  prepareAuthorizedQuotaRead,
  prepareConsumption,
  quotaFailure,
} from "../quotas/operations";
import { newId } from "../secret-material/operations";
import {
  type AuthorizedCanonicalCaller,
  CanonicalAdmissionUnavailable,
  canonicalRequestProtection,
} from "./contract";
import { cryptoHash, validatedCanonicalInput } from "./internal/request-input";
import { acquireRequest, admitUnresolvedSource, releaseRequest } from "./internal/protection";
import { type Replay, claimReplay, completeReplay, retainedReplay } from "./internal/replay";

type RequestCall<E, R> = Readonly<{
  db: D1Database;
  request: Request;
  caller: AuthorizedCanonicalCaller;
  operation: CatalogOperation;
  current: number;
  browserOrigin: string;
  work: Effect.Effect<Response, E, R>;
}>;
type Call<E, R> = RequestCall<E, R> & Readonly<{ scopes: ReadonlyArray<CanonicalCapability> }>;
type MeteredCall<E, R> = Call<E, R> &
  Readonly<{ identity: string; inputHash: string; retryKey: Option.Option<string> }>;
const unavailable = (): Response =>
  Response.json(
    {
      error: { code: "unavailable", message: "The operation is unavailable. Retry later." },
      next: [],
    },
    { status: 503 }
  );
const noAuthority = (): Response =>
  Response.json(
    {
      error: {
        code: "unauthenticated",
        message: "Present a currently authorized credential and retry.",
      },
      next: [],
    },
    { status: 401 }
  );
const scopeMissing = (): Response =>
  Response.json(
    {
      error: { code: "scope_missing", message: "A required canonical capability is missing." },
      next: [],
    },
    { status: 403 }
  );
const invalid = (message: string): Response =>
  Response.json({ error: { code: "validation_failed", message }, next: [] }, { status: 400 });
const rateLimited = (): Response =>
  Response.json(
    {
      error: {
        code: "rate_limited",
        message: "Too many concurrent or recent requests. Retry later.",
      },
      next: [],
    },
    {
      status: 429,
      headers: { "retry-after": String(canonicalRequestProtection.retryAfterSeconds) },
    }
  );
const exhausted = (current: number): Response =>
  Response.json(
    {
      error: {
        code: "quota_exhausted",
        message: "Your Free canonical-call allowance is exhausted.",
        allowance: "canonical_call",
        resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
      },
      next: [],
    },
    { status: 429 }
  );
const patAuthority = (
  caller: Extract<AuthorizedCanonicalCaller, { _tag: "PAT" }>,
  current: number,
  scopes: ReadonlyArray<CanonicalCapability>
): ReturnType<typeof livePATCredential> => {
  const credential = livePATCredential({ subject: caller.value, current });
  return {
    ...credential,
    predicate: `${credential.predicate} AND ${scopes.length === 0 ? "0" : scopes.map(() => "EXISTS (SELECT 1 FROM json_each(pats.scopes_json) WHERE value = ?)").join(" AND ")}`,
    bindings: [...credential.bindings, ...scopes],
  };
};
const authorityAt = (
  caller: AuthorizedCanonicalCaller,
  current: number,
  scopes: ReadonlyArray<CanonicalCapability>
): AuditAuthority =>
  caller._tag === "PAT"
    ? patAuthority(caller, current, scopes)
    : liveWebSessionAuthority({ subject: caller.value, current });
const proof = (authority: AuditAuthority): OwnedStatement => ({
  sql: `SELECT user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
  params: authority.bindings,
});
const bind = (db: D1Database, statement: OwnedStatement): D1PreparedStatement =>
  db.prepare(statement.sql).bind(...statement.params);
const batch = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<ReadonlyArray<D1Result>, CanonicalAdmissionUnavailable> =>
  Effect.tryPromise({
    try: () => db.batch([...statements]),
    catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
  });
const standing = <E, R>({
  db,
  caller,
  current,
  scopes,
}: Call<E, R>): Effect.Effect<Option.Option<QuotaStatus>, CanonicalAdmissionUnavailable> =>
  batch(
    db,
    prepareAuthorizedQuotaRead({
      db,
      userId: caller.value.userId,
      current,
      authority: proof(authorityAt(caller, current, scopes)),
    })
  ).pipe(Effect.map((rows) => decodeQuotaStatus({ row: rows[1]?.results[0], current })));
const checkScopes = <E, R>(
  input: Call<E, R>
): Effect.Effect<Option.Option<Response>, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    const { db, caller, current, scopes } = input;
    if (caller._tag !== "PAT") return Option.none();
    const credential = proof(livePATCredential({ subject: caller.value, current }));
    const scoped = proof(patAuthority(caller, current, scopes));
    const rows = yield* batch(db, [bind(db, credential), bind(db, scoped)]);
    if (rows[0]?.results.length !== 1) return Option.some(noAuthority());
    return rows[1]?.results.length === 1 ? Option.none() : Option.some(scopeMissing());
  });
const attachStanding = (response: Response, status: QuotaStatus, current: number): Response => {
  const headers = new Headers(response.headers);
  const meter = status.canonicalCalls;
  headers.set("Fidy-Canonical-Allowance", "canonical_call");
  headers.set("Fidy-Canonical-Limit", meter._tag === "Uncapped" ? "uncapped" : String(meter.limit));
  headers.set(
    "Fidy-Canonical-Remaining",
    meter._tag === "Uncapped" ? "uncapped" : String(meter.remaining)
  );
  headers.set(
    "Fidy-Canonical-Reset",
    DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt)
  );
  return new Response(response.body, { status: response.status, headers });
};
const replayResponse = (replay: Replay): Response => {
  if (replay.state !== "completed" || Option.isNone(replay.status) || Option.isNone(replay.body)) {
    return unavailable();
  }
  const headers = new Headers();
  Option.map(replay.contentType, (value) => headers.set("content-type", value));
  return new Response(replay.body.value, { status: replay.status.value, headers });
};
const disclose = <E, R>(
  input: Call<E, R>,
  response: Response
): Effect.Effect<Response, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const status = yield* standing({ ...input, current });
    if (Option.isNone(status)) return unavailable();
    return input.caller._tag === "PAT" ? attachStanding(response, status.value, current) : response;
  });
const inspection = <E, R>(
  input: Call<E, R>,
  operation: "quota.getQuota" | "subscription.getUpgradeUrl"
): Effect.Effect<Response, CanonicalAdmissionUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { db, caller, current, browserOrigin, scopes } = input;
    const authority = authorityAt(caller, current, scopes);
    const rows = yield* batch(db, [
      ...prepareAuthorizedQuotaRead({
        db,
        userId: caller.value.userId,
        current,
        authority: proof(authority),
      }),
      prepareAuthorizedAuditCall({
        db,
        authority,
        id: newId(),
        operation,
        outcome: "accepted",
        current,
        afterOwnerWrite: false,
      }),
      ...(caller._tag === "PAT"
        ? [
            bind(
              db,
              recordProtectedPATUse({ authority: patAuthority(caller, current, scopes), current })
            ),
          ]
        : []),
    ]);
    const status = decodeQuotaStatus({ row: rows[1]?.results[0], current });
    if (Option.isNone(status)) return unavailable();
    const data =
      operation === "quota.getQuota"
        ? yield* Schema.encodeEffect(Schema.toCodecJson(QuotaStatus))(status.value)
        : { url: new URL("/upgrade", browserOrigin).href };
    return Response.json({ data, next: [] });
  });
const matchingReplay = <E, R>(call: MeteredCall<E, R>, replay: Replay): Response =>
  replay.operation !== call.operation.id || replay.inputHash !== call.inputHash
    ? invalid("The retry key is already bound to different operation inputs.")
    : replayResponse(replay);
const replayOf = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Option.Option<Response>, CanonicalAdmissionUnavailable> => {
  if (Option.isNone(call.retryKey)) return Effect.succeedNone;
  return retainedReplay({
    db: call.db,
    userId: call.caller.value.userId,
    retryKey: call.retryKey.value,
    current: call.current,
  }).pipe(Effect.map((row) => Option.map(row, (replay) => matchingReplay(call, replay))));
};
const recoverAcceptance = <E, R>(
  call: MeteredCall<E, R>,
  failure: CanonicalAdmissionUnavailable
): Effect.Effect<Response, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    const kind = quotaFailure(failure.cause);
    if (kind === "authority") return noAuthority();
    if (kind === "exhausted") {
      yield* batch(call.db, [
        prepareCanonicalAdmissionRefusal({
          db: call.db,
          authority: authorityAt(call.caller, call.current, call.scopes),
          id: call.identity,
          operation: call.operation.id,
          current: call.current,
        }),
      ]);
      return exhausted(call.current);
    }
    return Option.getOrElse(yield* replayOf(call), unavailable);
  });
const acceptanceStatements = <E, R>(
  call: MeteredCall<E, R>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, caller, operation, current, inputHash, identity, retryKey, scopes } = call;
  if (caller._tag !== "PAT") return [];
  return [
    ...(Option.isSome(retryKey)
      ? claimReplay({
          db,
          userId: caller.value.userId,
          retryKey: retryKey.value,
          operation: operation.id,
          inputHash,
          identity,
          current,
        })
      : []),
    ...prepareConsumption({
      db,
      userId: caller.value.userId,
      allowance: "canonical_call",
      identity,
      current,
      authority: proof(authorityAt(caller, current, scopes)),
    }),
    db
      .prepare("INSERT INTO canonical_request_acceptances VALUES (?,?,?,?,?)")
      .bind(identity, caller.value.userId, caller.value.patId, operation.id, current),
    bind(db, recordProtectedPATUse({ authority: patAuthority(caller, current, scopes), current })),
  ];
};
const finishReplay = <E, R>(
  call: MeteredCall<E, R>,
  response: Response
): Effect.Effect<void, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(call.retryKey)) return;
    const body = yield* Effect.tryPromise({
      try: () => response.clone().text(),
      catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
    });
    const current = yield* Clock.currentTimeMillis;
    yield* batch(call.db, [
      ...prepareAuthorizedQuotaRead({
        db: call.db,
        userId: call.caller.value.userId,
        current,
        authority: proof(authorityAt(call.caller, current, call.scopes)),
      }),
      completeReplay({
        db: call.db,
        userId: call.caller.value.userId,
        retryKey: call.retryKey.value,
        identity: call.identity,
        response,
        body,
      }),
    ]);
  });
const externalCall = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable, R> =>
  Effect.gen(function* () {
    const replay = yield* replayOf(call);
    if (Option.isSome(replay)) return replay.value;
    const acceptance = yield* batch(call.db, acceptanceStatements(call)).pipe(Effect.result);
    if (acceptance._tag === "Failure") return yield* recoverAcceptance(call, acceptance.failure);
    const response = yield* call.work;
    yield* finishReplay(call, response);
    return response;
  });
const operationResponse = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable | Schema.SchemaError, R> => {
  if (call.operation.id === "quota.getQuota") return inspection(call, "quota.getQuota");
  if (call.operation.id === "subscription.getUpgradeUrl") {
    return inspection(call, "subscription.getUpgradeUrl");
  }
  if (call.caller._tag === "WebSession") return call.work;
  return externalCall(call);
};
const authorizedCall = <E, R>(
  input: RequestCall<E, R>,
  identity: string
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable | Schema.SchemaError, R> =>
  Effect.gen(function* () {
    const valid = yield* validatedCanonicalInput(input);
    if (Option.isNone(valid)) return invalid("Invalid canonical operation input.");
    const authorized: Call<E, R> = { ...input, scopes: valid.value.scopes };
    const scopeFailure = yield* checkScopes(authorized);
    if (Option.isSome(scopeFailure)) return scopeFailure.value;
    const wireKey = Option.fromNullishOr(input.request.headers.get("Fidy-Retry-Key"));
    const key = Option.flatMap(wireKey, Schema.decodeOption(CanonicalRetryKey));
    if (Option.isSome(wireKey) && Option.isNone(key)) {
      return invalid("Invalid canonical retry key.");
    }
    const retryKey = Option.isNone(key)
      ? Option.none<string>()
      : Option.some(yield* cryptoHash(key.value));
    const response = yield* operationResponse({
      ...authorized,
      identity,
      inputHash: valid.value.inputHash,
      retryKey,
    });
    return yield* disclose(authorized, response);
  });

/** Trusted public ingress supplies a keyed source; no caller-selected policy or plaintext source is accepted. */
export const protectCanonicalSource = ({
  db,
  request,
  current,
}: Readonly<{ db: D1Database; request: Request; current: number }>): Effect.Effect<
  Option.Option<Response>
> =>
  Effect.gen(function* () {
    const source = request.headers.get("x-canonical-source");
    if (source === null) return Option.none();
    if (!/^[0-9a-f]{64}$/u.test(source)) return Option.some(unavailable());
    const result = yield* admitUnresolvedSource({ db, source, current });
    return result === "accepted"
      ? Option.none()
      : Option.some(result === "rate_limited" ? rateLimited() : unavailable());
  });

/** One external envelope is charged before work; exact replay never starts new work. Browser calls are commercially free. */
export const protectCanonicalRequest = <E, R>(
  input: RequestCall<E, R>
): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const id = newId();
    const protection = yield* acquireRequest({
      db: input.db,
      userId: input.caller.value.userId,
      id,
      current: input.current,
    });
    if (protection !== "accepted") {
      return protection === "rate_limited" ? rateLimited() : unavailable();
    }
    return yield* authorizedCall(input, id).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          failure instanceof CanonicalAdmissionUnavailable &&
            quotaFailure(failure.cause) === "authority"
            ? noAuthority()
            : unavailable()
        )
      ),
      Effect.ensuring(releaseRequest({ db: input.db, id }))
    );
  });
