import { OAuthNativeReview } from "../oauth-confirmation/contract";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { UserActionRequired } from "../../src/shell/public-http/contract";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import type { AuditAuthority } from "../../src/shell/audit/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { userOwnedAgentCapability } from "../../src/shell/canonical-policy/contract";
import type { CanonicalCapability } from "../../src/core/canonical-operations/contract";
import {
  livePATCredential,
  recordAuditedPATUseFromAuthority,
} from "../../src/shell/tokens/operations";
import { liveWebSessionAuthority } from "../../src/shell/identity/operations";
import {
  prepareCanonicalAdmissionRefusal,
  prepareCanonicalReplayAccess,
  recordedPATReplayCallProof,
  refusedByAuditBudget,
} from "../../src/shell/audit/operations";
import { CanonicalRetryKey, type QuotaStatus } from "../../src/core/quotas/contract";
import { allowancePeriod } from "../../src/core/quotas/operations";
import {
  bindConsumptionRetry,
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
  caller: AuthorizedCanonicalCaller;
  operation: CatalogOperation;
  current: number;
  work: Effect.Effect<Response, E, R>;
}> &
  (
    | Readonly<{ request: Request }>
    | Readonly<{
        canonicalInput: Schema.Json;
        retryKey: Option.Option<unknown>;
        /** Server-bound continuation; the confirmation owner retains single-use authority. */
        confirmationReference: Option.Option<string>;
      }>
  );
type Call<E, R> = RequestCall<E, R> & Readonly<{ scopes: ReadonlyArray<CanonicalCapability> }>;
type MeteredCall<E, R> = Call<E, R> &
  Readonly<{
    identity: string;
    consumptionIdentity: string;
    inputHash: string;
    retryKey: Option.Option<string>;
  }>;
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
      error: {
        code: "scope_missing",
        message: "This credential lacks the required operation scope.",
      },
      next: [],
    },
    { status: 403 }
  );
const invalid = (message: string): Response =>
  Response.json(
    { error: { code: "validation_failed", message, fields: [] }, next: [] },
    { status: 400 }
  );
const rateLimited = (): Response =>
  Response.json(
    {
      error: {
        code: "rate_limited",
        message: "Too many concurrent or recent requests. Retry later.",
        retryAfterSeconds: canonicalRequestProtection.retryAfterSeconds,
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
/** Bound shared User request pressure without consuming a commercial allowance or adding canonical accounting. */
export const protectCanonicalPressure = <A, E, R>(
  input: Readonly<{
    db: D1Database;
    userId: string;
    work: Effect.Effect<A, E, R>;
    refused: (response: Response) => Effect.Effect<A, E, R>;
  }>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const id = newId();
      const admitted = yield* acquireRequest({
        db: input.db,
        userId: input.userId,
        id,
        current: yield* Clock.currentTimeMillis,
      });
      return { id, admitted };
    }),
    ({ admitted }) =>
      admitted === "accepted"
        ? input.work
        : input.refused(admitted === "rate_limited" ? rateLimited() : unavailable()),
    ({ id, admitted }) =>
      admitted === "accepted" ? releaseRequest({ db: input.db, id }) : Effect.void
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
const oauthAuthority = (
  caller: Extract<AuthorizedCanonicalCaller, { _tag: "OAuth" }>,
  current: number,
  scopes: ReadonlyArray<CanonicalCapability>
): AuditAuthority & { table: "oauth_access_credentials" } => {
  const authority = liveOAuthAuthority({
    subject: { ...caller.value, requiredScope: Option.none() },
    current,
  });
  const scoped = scopes.map((scope) =>
    liveOAuthAuthority({ subject: { ...caller.value, requiredScope: Option.some(scope) }, current })
  );
  return {
    ...authority,
    predicate: `${authority.predicate} AND ${scoped.length === 0 ? "0" : scoped.map(({ predicate }) => `(${predicate})`).join(" AND ")}`,
    bindings: [...authority.bindings, ...scoped.flatMap(({ bindings }) => bindings)],
  };
};
const credentialAt = (caller: AuthorizedCanonicalCaller, current: number): AuditAuthority => {
  switch (caller._tag) {
    case "PAT":
      return livePATCredential({ subject: caller.value, current });
    case "OAuth":
      return liveOAuthAuthority({
        subject: { ...caller.value, requiredScope: Option.none() },
        current,
      });
    case "WebSession":
      return liveWebSessionAuthority({ subject: caller.value, current });
  }
};
const authorityAt = (
  caller: AuthorizedCanonicalCaller,
  current: number,
  scopes: ReadonlyArray<CanonicalCapability>
): AuditAuthority => {
  switch (caller._tag) {
    case "PAT":
      return patAuthority(caller, current, scopes);
    case "OAuth":
      return oauthAuthority(caller, current, scopes);
    case "WebSession":
      return liveWebSessionAuthority({ subject: caller.value, current });
  }
};
const externalAuthority = (
  caller: Exclude<AuthorizedCanonicalCaller, { _tag: "WebSession" }>,
  current: number,
  scopes: ReadonlyArray<CanonicalCapability>
): AuditAuthority & { table: "pats" | "oauth_access_credentials" } =>
  caller._tag === "PAT"
    ? patAuthority(caller, current, scopes)
    : oauthAuthority(caller, current, scopes);
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
    if (caller._tag === "WebSession") return Option.none();
    const credential = proof(credentialAt(caller, current));
    const scoped = proof(authorityAt(caller, current, scopes));
    const rows = yield* batch(db, [bind(db, credential), bind(db, scoped)]);
    if (rows[0]?.results.length !== 1) return Option.some(noAuthority());
    return rows[1]?.results.length === 1 ? Option.none() : Option.some(scopeMissing());
  });
const attachStanding = (response: Response, status: QuotaStatus, current: number): Response => {
  const headers = new Headers(response.headers);
  const meter = status.canonicalCalls;
  headers.set(canonicalAllowanceHeaders.allowance, "canonical_call");
  headers.set(
    canonicalAllowanceHeaders.limit,
    meter._tag === "Uncapped" ? "uncapped" : String(meter.limit)
  );
  headers.set(
    canonicalAllowanceHeaders.remaining,
    meter._tag === "Uncapped" ? "uncapped" : String(meter.remaining)
  );
  headers.set(
    canonicalAllowanceHeaders.resetsAt,
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
const forbiddenHttpStatus = 403;
/** A withdrawn-Consent refusal is public recovery guidance, never the original financial body. Rebuild the closed refusal instead of turning it into an invalid-credential response. */
const deniedDisclosure = (response: Response): Effect.Effect<Response> => {
  if (response.status !== forbiddenHttpStatus) return Effect.succeed(noAuthority());
  return Effect.tryPromise({ try: () => response.clone().json(), catch: () => undefined }).pipe(
    Effect.map((body) => Schema.decodeUnknownOption(UserActionRequired)(body)),
    Effect.map((refusal) =>
      Option.isSome(refusal)
        ? Response.json(
            {
              error: {
                code: "user_action_required",
                message: "Return to Fidy to review your withdrawn Consent.",
              },
              next: [],
            },
            { status: forbiddenHttpStatus }
          )
        : noAuthority()
    ),
    Effect.orElseSucceed(noAuthority)
  );
};
const disclose = <E, R>(
  input: Call<E, R>,
  response: Response
): Effect.Effect<Response, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const status = yield* standing({ ...input, current });
    if (Option.isNone(status)) return unavailable();
    return input.caller._tag !== "WebSession"
      ? attachStanding(response, status.value, current)
      : response;
  }).pipe(
    Effect.catchIf(
      (failure) => quotaFailure(failure.cause) === "authority",
      () => deniedDisclosure(response)
    )
  );
const matchingReplay = <E, R>(call: MeteredCall<E, R>, replay: Replay): Response =>
  replay.operation !== call.operation.id || replay.inputHash !== call.inputHash
    ? invalid("The retry key is already bound to different operation inputs.")
    : replayResponse(replay);
const unsuccessfulHttpStatus = 400;
const replayReceiptComplete = ({
  rows,
  accepted,
}: Readonly<{ rows: ReadonlyArray<D1Result>; accepted: boolean }>): boolean =>
  rows[0]?.meta.changes === 1 && (!accepted || rows[1]?.meta.changes === 1);

const replayPATActivity = ({
  db,
  authority,
  accepted,
  current,
  auditId,
  operation,
}: Readonly<{
  db: D1Database;
  authority: AuditAuthority;
  accepted: boolean;
  current: number;
  auditId: string;
  operation: CatalogOperation;
}>): ReadonlyArray<D1PreparedStatement> =>
  accepted && authority.table === "pats"
    ? [
        bind(
          db,
          recordAuditedPATUseFromAuthority({
            authority: {
              table: "pats",
              predicate: authority.predicate,
              bindings: authority.bindings,
            },
            current,
            evidence: recordedPATReplayCallProof({ auditId, operation: operation.id }),
          })
        ),
      ]
    : [];
const retryWireKey = <E, R>(input: RequestCall<E, R>): Option.Option<unknown> =>
  "request" in input
    ? Option.fromNullishOr(input.request.headers.get("Fidy-Retry-Key"))
    : input.retryKey;

const auditReplay = <E, R>({
  call,
  replay,
  current,
}: Readonly<{ call: MeteredCall<E, R>; replay: Replay; current: number }>): Effect.Effect<
  Response,
  CanonicalAdmissionUnavailable
> =>
  Effect.gen(function* () {
    const { db, caller, retryKey, operation, scopes } = call;
    if (caller._tag === "WebSession" || Option.isNone(retryKey)) return unavailable();
    const response = replayResponse(replay);
    const authority = externalAuthority(caller, current, scopes);
    const auditId = newId();
    const accepted = response.status < unsuccessfulHttpStatus;
    const rows = yield* batch(db, [
      prepareCanonicalReplayAccess({
        db,
        authority,
        id: auditId,
        operation: operation.id,
        current,
        outcome: accepted ? "accepted" : "rejected",
        retainedResponseProof: {
          sql: "SELECT 1 FROM canonical_request_replays WHERE user_id = ? AND retry_key_digest = ? AND identity = ? AND operation = ? AND input_digest = ? AND state = 'completed' AND expires_at_ms = ? AND expires_at_ms > ?",
          params: [
            caller.value.userId,
            retryKey.value,
            replay.identity,
            operation.id,
            call.inputHash,
            replay.expiresAt,
            current,
          ],
        },
      }),
      ...replayPATActivity({ db, authority, accepted, current, auditId, operation }),
    ]);
    return replayReceiptComplete({ rows, accepted: accepted && authority.table === "pats" })
      ? response
      : unavailable();
  });

const replayOf = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Option.Option<Response>, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(call.retryKey)) return Option.none();
    const current = Math.max(call.current, yield* Clock.currentTimeMillis);
    const row = yield* retainedReplay({
      db: call.db,
      userId: call.caller.value.userId,
      retryKey: call.retryKey.value,
      current,
    });
    if (Option.isNone(row)) return Option.none();
    const replay = row.value;
    if (
      replay.operation !== call.operation.id ||
      replay.inputHash !== call.inputHash ||
      replay.state !== "completed"
    ) {
      return Option.some(yield* unadmittedRefusal(call, newId(), matchingReplay(call, replay)));
    }
    return Option.some(yield* auditReplay({ call, replay, current }));
  });
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
  if (caller._tag === "WebSession") return [];
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
      identity: call.consumptionIdentity,
      current,
      authority: proof(authorityAt(caller, current, scopes)),
    }),
    ...(caller._tag === "PAT"
      ? [
          db
            .prepare("INSERT INTO canonical_request_acceptances VALUES (?,?,?,?,?)")
            .bind(identity, caller.value.userId, caller.value.patId, operation.id, current),
        ]
      : []),
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
const retainReviewConsumption = <E, R>(
  call: MeteredCall<E, R>,
  response: Response
): Effect.Effect<void, CanonicalAdmissionUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (call.caller._tag !== "OAuth" || response.headers.get("fidy-oauth-review") !== "1") return;
    const raw: unknown = yield* Effect.tryPromise({
      try: () => response.clone().json(),
      catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
    });
    const review = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(OAuthNativeReview))(raw);
    const retryIdentity = yield* cryptoHash(
      `${call.caller.value.oauthConnectionId}:${review.reference}:${call.operation.id}:${call.inputHash}`
    );
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* batch(call.db, [
      bindConsumptionRetry({
        db: call.db,
        userId: call.caller.value.userId,
        allowance: "canonical_call",
        identity: call.consumptionIdentity,
        retryIdentity,
        current,
        authority: proof(authorityAt(call.caller, current, call.scopes)),
      }),
    ]);
    if (rows[0]?.meta.changes !== 1) {
      return yield* new CanonicalAdmissionUnavailable({
        cause: "Continuation accounting unavailable",
      });
    }
  });

const externalCall = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable | Schema.SchemaError, R> =>
  Effect.gen(function* () {
    const replay = yield* replayOf(call);
    if (Option.isSome(replay)) return replay.value;
    const acceptance = yield* batch(call.db, acceptanceStatements(call)).pipe(Effect.result);
    if (acceptance._tag === "Failure") return yield* recoverAcceptance(call, acceptance.failure);
    const response = yield* call.work;
    yield* retainReviewConsumption(call, response);
    yield* finishReplay(call, response);
    return response;
  });
const operationResponse = <E, R>(
  call: MeteredCall<E, R>
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable | Schema.SchemaError, R> => {
  if (
    call.operation.id === "quota.getQuota" ||
    call.operation.id === "subscription.getUpgradeUrl"
  ) {
    return call.work;
  }
  if (call.caller._tag === "WebSession") return call.work;
  return externalCall(call);
};
const primaryScopeFailure = <E, R>(
  input: RequestCall<E, R>
): Effect.Effect<Option.Option<Response>, CanonicalAdmissionUnavailable> => {
  if (input.operation.id === "operations.executeAtomicBatch") return Effect.succeedNone;
  const scope = userOwnedAgentCapability(input.operation.policy.access);
  return checkScopes({ ...input, scopes: Option.isSome(scope) ? [scope.value] : [] });
};

const unadmittedRefusal = <E, R>(
  input: RequestCall<E, R>,
  identity: string,
  response: Response
): Effect.Effect<Response, CanonicalAdmissionUnavailable> =>
  Effect.gen(function* () {
    if (input.caller._tag === "WebSession") return response;
    const result = yield* batch(input.db, [
      prepareCanonicalAdmissionRefusal({
        db: input.db,
        authority: credentialAt(input.caller, input.current),
        id: identity,
        operation: input.operation.id,
        current: input.current,
      }),
    ]).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (refusedByAuditBudget(result.failure.cause)) return rateLimited();
      return yield* result.failure;
    }
    return result.success[0]?.meta.changes === 1 ? response : noAuthority();
  });

const consumptionReference = <E, R>(
  input: RequestCall<E, R>,
  identity: string,
  inputHash: string
): Effect.Effect<string, CanonicalAdmissionUnavailable> => {
  const reference = "canonicalInput" in input ? input.confirmationReference : Option.none<string>();
  return Option.isNone(reference)
    ? Effect.succeed(identity)
    : cryptoHash(`${reference.value}:${input.operation.id}:${inputHash}`);
};

const invalidInputResponse = <E, R>(
  input: RequestCall<E, R>,
  identity: string
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable, R> =>
  input.caller._tag === "OAuth"
    ? input.work
    : unadmittedRefusal(input, identity, invalid("Invalid canonical operation input."));

const authorizedCall = <E, R>(
  input: RequestCall<E, R>,
  identity: string
): Effect.Effect<Response, E | CanonicalAdmissionUnavailable | Schema.SchemaError, R> =>
  Effect.gen(function* () {
    // Browser work has no commercial charge. Keep its owner's canonical input/refusal contract;
    // external envelopes alone require reflected preflight before spending a commercial unit.
    if (input.caller._tag === "WebSession") {
      return yield* disclose({ ...input, scopes: [] }, yield* input.work);
    }
    // A batch derives authority from its decoded children, not a synthetic envelope capability.
    const primaryFailure = yield* primaryScopeFailure(input);
    if (Option.isSome(primaryFailure)) {
      return yield* unadmittedRefusal(input, identity, primaryFailure.value);
    }
    const valid = yield* validatedCanonicalInput(input);
    if (Option.isNone(valid)) return yield* invalidInputResponse(input, identity);
    const authorized: Call<E, R> = { ...input, scopes: valid.value.scopes };
    const scopeFailure = yield* checkScopes(authorized);
    if (Option.isSome(scopeFailure)) {
      return yield* unadmittedRefusal(input, identity, scopeFailure.value);
    }
    const wireKey = retryWireKey(input);
    const key = Option.flatMap(wireKey, Schema.decodeUnknownOption(CanonicalRetryKey));
    if (Option.isSome(wireKey) && Option.isNone(key)) {
      return yield* unadmittedRefusal(input, identity, invalid("Invalid canonical retry key."));
    }
    const retryKey = Option.isNone(key)
      ? Option.none<string>()
      : Option.some(yield* cryptoHash(key.value));
    const consumptionIdentity = yield* consumptionReference(input, identity, valid.value.inputHash);
    const response = yield* operationResponse({
      ...authorized,
      identity,
      consumptionIdentity,
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
const executeProtectedRequest = <E, R>(
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

/** Header disclosure proves only the live User-owned credential and Consent, not business capability. Missing scope or invalid input can still report that User's allowance; failed proof discloses nothing. */
export const discloseCanonicalAllowance = ({
  db,
  caller,
  response,
}: Readonly<{
  db: D1Database;
  caller: AuthorizedCanonicalCaller;
  response: Response;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const authority = credentialAt(caller, current);
    const rows = yield* batch(
      db,
      prepareAuthorizedQuotaRead({
        db,
        userId: caller.value.userId,
        current,
        authority: proof(authority),
      })
    );
    const status = decodeQuotaStatus({ row: rows[1]?.results[0], current });
    return Option.isSome(status) ? attachStanding(response, status.value, current) : noAuthority();
  }).pipe(
    Effect.catch((failure) =>
      quotaFailure(failure.cause) === "authority"
        ? deniedDisclosure(response)
        : Effect.succeed(unavailable())
    )
  );

/** Decorate all authenticated outcomes, including validation, protection and dependency refusals, without spending a commercial unit or relaxing owner disclosure authority. */
export const protectCanonicalRequest = <E, R>(
  input: RequestCall<E, R>
): Effect.Effect<Response, never, R> =>
  executeProtectedRequest(input).pipe(
    Effect.flatMap((response) =>
      discloseCanonicalAllowance({ db: input.db, caller: input.caller, response })
    )
  );

/** Meter canonical work inside an already pressure-protected MCP invocation under the User coordinator. */
export const admitCanonicalOperation = <E, R>(
  input: RequestCall<E, R>
): Effect.Effect<Response, never, R> =>
  authorizedCall(input, newId()).pipe(
    Effect.orElseSucceed(unavailable),
    Effect.flatMap((response) =>
      discloseCanonicalAllowance({ db: input.db, caller: input.caller, response })
    )
  );
