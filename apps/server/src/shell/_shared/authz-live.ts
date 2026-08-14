import {
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Exit,
  Function,
  Layer,
  type Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type AuditLogEntry, type AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import { type ResolvedToken, TokenBearer } from "~/core/tokens/model";
import { computePatIdleExpiry } from "~/core/tokens/rules";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { useCurrentConsent } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TokenHash, useToken } from "~/shell/tokens/repo";
import { ConsentRequired, ScopeMissing, Unauthenticated } from "./errors";
import {
  ChildOperationAudit,
  type ChildOperationAuditService,
  ResolvedCaller,
  TokenAuthorization,
} from "./authz";
import { getOperationPolicy } from "./operation-policy";

const decodeBearer = Schema.decodeUnknownEffect(TokenBearer);

const unauthenticated = (): Unauthenticated =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "Every operation requires a known PAT or internal HostedTurnToken. Send its opaque fin_ " +
        "bearer in the Authorization header and retry.",
    },
    next: [],
  });

const scopeMissing = (): ScopeMissing =>
  ScopeMissing.make({
    error: {
      code: "scope_missing",
      message:
        "This bearer does not grant the scope declared by the attempted operation. " +
        "Ask the User to mint or broaden a PAT in /settings/pats before retrying.",
    },
    next: [],
  });

const consentRequired = (): ConsentRequired =>
  ConsentRequired.make({
    error: {
      code: "consent_required",
      message:
        "The User has no current onboarding consent. Return to the chat disclosure flow; " +
        "do not retry or execute any canonical operation until explicit acceptance.",
    },
    next: [],
  });

class ConsentAuthenticationRejected extends Data.TaggedError("ConsentAuthenticationRejected")<{
  readonly resolved: ResolvedToken;
}> {}

class ScopeAuthenticationRejected extends Data.TaggedError("ScopeAuthenticationRejected")<{
  readonly resolved: ResolvedToken;
}> {}

/**
 * SHA-256 hashes one opaque bearer with the platform Crypto service. Token
 * lookup accepts this lowercase digest and never the full bearer or its secret.
 */
export const hashTokenBearer = (
  bearer: TokenBearer
): Effect.Effect<TokenHash, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(bearer))
  ).pipe(
    Effect.map((digest) => TokenHash.make(Encoding.encodeHex(digest))),
    Effect.orDie
  );

/**
 * Resolves a typed TokenBearer bearer to its stable User and atomically records
 * the supplied use time while renewing its 90-day idle deadline. The caller
 * supplies one UTC instant for both writes. Unknown, revoked, and idle-expired
 * grants remain `None`; database failures are defects.
 */
export const authenticateTokenBearer: {
  (
    usedAt: DateTime.Utc
  ): (
    self: TokenBearer
  ) => Effect.Effect<Option.Option<ResolvedToken>, never, Crypto.Crypto | SqlClient.SqlClient>;
  (
    self: TokenBearer,
    usedAt: DateTime.Utc
  ): Effect.Effect<Option.Option<ResolvedToken>, never, Crypto.Crypto | SqlClient.SqlClient>;
} = Function.dual(2, (self: TokenBearer, usedAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const tokenHash = yield* hashTokenBearer(self);
    const renewedIdleExpiresAt = yield* computePatIdleExpiry(usedAt);
    return yield* useToken({ tokenHash, usedAt, renewedIdleExpiresAt });
  })
);

const recordAuthorizationOutcome = ({
  resolved,
  operation,
  outcome,
  occurredAt,
}: Readonly<{
  resolved: ResolvedToken;
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  appendAuditLogEntry(resolved.subjectUserId, {
    tokenId: resolved.tokenId,
    operation,
    outcome,
    occurredAt,
  });

const annotateOperationPolicy = (
  policy: ReturnType<typeof getOperationPolicy>
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    "fidy.operation.required_scope": policy.requiredScope,
  });

const recordRejectedAttempt = (
  attempt: Readonly<{
    resolved: ResolvedToken;
    operation: CanonicalOperationId;
    occurredAt: DateTime.Utc;
  }>
): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  recordAuthorizationOutcome({ ...attempt, outcome: "rejected" });

const operationAudit =
  (attempt: {
    readonly resolved: ResolvedToken;
    readonly operation: CanonicalOperationId;
    readonly occurredAt: DateTime.Utc;
  }): ((outcome: AuditOutcome) => Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient>) =>
  (outcome) =>
    recordAuthorizationOutcome({ ...attempt, outcome });

const provideRequestServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  resolved: ResolvedToken,
  childOperationAudit: ChildOperationAuditService
): Effect.Effect<A, E, Exclude<Exclude<R, ResolvedCaller>, ChildOperationAudit>> =>
  effect.pipe(
    Effect.provideService(ResolvedCaller, resolved),
    Effect.provideService(ChildOperationAudit, childOperationAudit)
  );

type ChildAuditEvidence = Readonly<{
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>;

const flushChildEvidence = Effect.fn("flushChildOperationAuditEvidence")(function* (
  childEvidence: Ref.Ref<ReadonlyArray<ChildAuditEvidence>>,
  resolved: ResolvedToken
) {
  for (const evidence of yield* Ref.get(childEvidence)) {
    yield* recordAuthorizationOutcome({ resolved, ...evidence });
  }
});

type AuthorizedEndpointInput<A, E, R> = Readonly<{
  httpEffect: Effect.Effect<A, E, R>;
  resolved: ResolvedToken;
  policy: ReturnType<typeof getOperationPolicy>;
  operation: CanonicalOperationId;
  occurredAt: DateTime.Utc;
}>;

const executeAuthorizedEndpoint = Effect.fn("executeAuthorizedEndpoint")(function* <A, E, R>({
  httpEffect,
  occurredAt,
  operation,
  policy,
  resolved,
}: AuthorizedEndpointInput<A, E, R>) {
  if (policy.scopeEvaluation !== "children" && !resolved.scopes.includes(policy.requiredScope)) {
    return yield* new ScopeAuthenticationRejected({ resolved });
  }

  yield* annotateOperationPolicy(policy);
  const sql = yield* SqlClient.SqlClient;
  const audit = operationAudit({ resolved, operation, occurredAt });
  const childEvidence = yield* Ref.make<ReadonlyArray<ChildAuditEvidence>>([]);
  const childOperationAudit = ChildOperationAudit.of({
    record: (evidence) => Ref.update(childEvidence, (entries) => [...entries, evidence]),
  });
  const authorizedEffect = provideRequestServices(httpEffect, resolved, childOperationAudit);
  const exit = yield* Effect.exit(
    sql.withTransaction(authorizedEffect.pipe(Effect.tap(audit.bind(null, "succeeded"))))
  );
  if (Exit.isFailure(exit)) {
    yield* audit("failed");
    yield* Ref.update(childEvidence, (entries) =>
      entries.map((entry) =>
        entry.outcome === "succeeded" ? { ...entry, outcome: "failed" as const } : entry
      )
    );
  }
  yield* flushChildEvidence(childEvidence, resolved);
  return { _tag: "OperationCompleted", exit } as const;
});

/**
 * Live operation-derived bearer authorization for the HTTP server. Each call
 * authenticates its bearer, requires current onboarding consent, rejects a
 * missing declared scope, and appends metadata-only AuditLogEntry evidence.
 * Missing consent rolls back token renewal and returns `ConsentRequired` after
 * recording rejection evidence. A successful operation and its evidence commit
 * in one SQL transaction; rejected and failed attempts append their evidence
 * separately. Authentication, consent, and scope failures remain typed HTTP
 * failures, while persistence failures are defects.
 */
export const TokenAuthorizationLive = Layer.succeed(
  TokenAuthorization,
  TokenAuthorization.of({
    agentBearer: Effect.fn(function* (httpEffect, { credential: redactedBearer, endpoint, group }) {
      const policy = getOperationPolicy(endpoint);
      const operation = CanonicalOperationId.make(`${group.identifier}.${endpoint.identifier}`);
      const bearer = yield* decodeBearer(Redacted.value(redactedBearer)).pipe(
        Effect.mapError(unauthenticated)
      );
      const occurredAt = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const resolved = yield* authenticateTokenBearer(bearer, occurredAt).pipe(
              Effect.flatMap(Effect.fromOption(unauthenticated))
            );
            return yield* withUserTransaction(
              resolved.subjectUserId,
              useCurrentConsent(
                resolved.subjectUserId,
                () => Effect.fail(new ConsentAuthenticationRejected({ resolved })),
                executeAuthorizedEndpoint({
                  httpEffect,
                  resolved,
                  policy,
                  operation,
                  occurredAt,
                })
              )
            );
          })
        )
        .pipe(
          Effect.catchTags({
            ConsentAuthenticationRejected: ({ resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(consentRequired())
              ),
            ScopeAuthenticationRejected: ({ resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(scopeMissing())
              ),
            SqlError: Effect.die,
          })
        );

      return yield* result.exit.pipe(Effect.catchTag("SqlError", Effect.die));
    }),
  })
);
