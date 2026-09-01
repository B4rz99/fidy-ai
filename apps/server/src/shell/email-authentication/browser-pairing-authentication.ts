import { timingSafeEqual } from "node:crypto";
import {
  Crypto,
  DateTime,
  Effect,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Struct,
} from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  BrowserPairingEmailStartRequestClaimToken,
  BrowserPairingEmailStartRequestId,
  BrowserPairingEmailWorkflowAwaitingDelivery,
  BrowserPairingEmailWorkflowId,
  EmailAddress,
  EmailDeliveryIntentId,
  type EmailVerificationCode,
  EmailVerificationDigest,
  EmailVerificationProof,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import {
  browserPairingEmailRetryAfterSeconds,
  decideBrowserPairingEmailRequest,
  decideProofAttempt,
  formatEmailCode,
  resendAvailability,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import { UserId } from "~/core/identity/reference";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { withSubjectLockInScope } from "~/shell/consent/repo";
import { BrowserLoginPairingInvalid } from "~/shell/browser-login/errors";
import {
  approveBrowserLoginPairingWithPrivateVerifierInScope,
  checkBrowserLoginPrivateVerifier,
  checkBrowserLoginPrivateVerifierInScope,
  lockPendingBrowserLoginPairingInScope,
} from "~/shell/browser-login/service";
import {
  admitEmailDeliveryInScope,
  emailAuthenticationHmacKey,
  emailCredentialLookupKey,
} from "./admission";
import { acquireEmailVerificationAdmissionInScope } from "./repo";

const maximumEvidenceKeys = 150_000;
const maximumAddressStarts = 5;
const maximumPairingStarts = 5;
const maximumSourceBurstStarts = 5;
const maximumSourceWindowStarts = 10;
const publicSymbolCount = 8;
const groupSize = 4;
const proofOffset = 10;
const startWorkDeadlineMilliseconds = 225;
const startResponseReleaseMilliseconds = 300;

const decodeEmailAddress = Schema.decodeUnknownResult(EmailAddress);

const normalizedAdmissionAddress = (input: unknown): string =>
  Option.getOrElse(
    Option.map(Option.liftPredicate(input, Predicate.isString), (value) =>
      value.trim().toLowerCase()
    ),
    () => ""
  );

type AdmissionScope = Readonly<{
  key: string;
  kind: "address" | "pairing" | "source";
  expiresAt: DateTime.Utc;
}>;

type AdmissionCheck = Readonly<{
  key: string;
  startsAt: DateTime.Utc;
  maximumAttempts: number;
}>;

type AdmissionRequest = Readonly<{
  attemptedAt: DateTime.Utc;
  scopes: ReadonlyArray<AdmissionScope>;
  checks: ReadonlyArray<AdmissionCheck>;
}>;

const AdmissionCapacity = Schema.Struct({ totalKeys: Schema.Int, existingKeys: Schema.Int });
const AdmissionAttemptCount = Schema.Struct({ count: Schema.Int });

const lockAndPurgeAdmissionEvidenceInScope = Effect.fn(
  "EmailAuthentication.lockAndPurgePairingAdmissionEvidenceInScope"
)(function* (sql: SqlClient.SqlClient, attemptedAt: DateTime.Utc) {
  const lock = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ acquired: Schema.Boolean }),
    execute: () => sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended('email-authentication:browser-pairing-admission', 0)
      ) AS acquired
    `,
  })(undefined);
  if (!lock.acquired) return false;
  yield* sql`
    DELETE FROM email_pairing_login_admission_scopes WHERE expires_at <= ${attemptedAt}
  `;
  return true;
});

const hasAdmissionCapacityInScope = Effect.fn(
  "EmailAuthentication.hasPairingAdmissionCapacityInScope"
)(function* (sql: SqlClient.SqlClient, scopes: ReadonlyArray<AdmissionScope>) {
  const keys = scopes.map(({ key }) => key);
  const capacity = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: AdmissionCapacity,
    execute: () => sql`
      SELECT
        (SELECT count(*)::int FROM email_pairing_login_admission_scopes) AS "totalKeys",
        (SELECT count(*)::int FROM email_pairing_login_admission_scopes
          WHERE scope_key = ANY(${keys})) AS "existingKeys"
    `,
  })(undefined);
  return capacity.totalKeys + scopes.length - capacity.existingKeys <= maximumEvidenceKeys;
});

const checksAllowAdmissionInScope = Effect.fn(
  "EmailAuthentication.checkPairingAdmissionEvidenceInScope"
)(function* (sql: SqlClient.SqlClient, checks: ReadonlyArray<AdmissionCheck>) {
  const allowed = yield* Effect.forEach(checks, (check) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: AdmissionAttemptCount,
      execute: () => sql`
        SELECT count(*)::int AS count FROM email_pairing_login_admission_attempts
        WHERE scope_key = ${check.key} AND attempted_at > ${check.startsAt}
      `,
    })(undefined).pipe(Effect.map(({ count }) => count < check.maximumAttempts))
  );
  return allowed.every(Boolean);
});

const persistAdmissionEvidenceInScope = Effect.fn(
  "EmailAuthentication.persistPairingAdmissionEvidenceInScope"
)(function* (sql: SqlClient.SqlClient, input: AdmissionRequest) {
  yield* Effect.forEach(
    input.scopes,
    (scope) =>
      sql`
      INSERT INTO email_pairing_login_admission_scopes (scope_key, scope_kind, expires_at)
      VALUES (${scope.key}, ${scope.kind}, ${scope.expiresAt})
      ON CONFLICT (scope_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `
  );
  yield* Effect.forEach(
    input.scopes,
    (scope) =>
      sql`
      INSERT INTO email_pairing_login_admission_attempts (scope_key, attempted_at)
      VALUES (${scope.key}, ${input.attemptedAt})
    `
  );
});

const consumeAdmissionEvidenceInScope = Effect.fn(
  "EmailAuthentication.consumePairingAdmissionEvidenceInScope"
)(function* (sql: SqlClient.SqlClient, input: AdmissionRequest) {
  if (!(yield* lockAndPurgeAdmissionEvidenceInScope(sql, input.attemptedAt))) return false;
  if (!(yield* hasAdmissionCapacityInScope(sql, input.scopes))) return false;
  if (!(yield* checksAllowAdmissionInScope(sql, input.checks))) return false;
  yield* persistAdmissionEvidenceInScope(sql, input);
  return true;
});

const consumeAdmissionEvidence = Effect.fn("EmailAuthentication.consumePairingAdmission")(
  function* (input: AdmissionRequest) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(consumeAdmissionEvidenceInScope(sql, input).pipe(Effect.orDie))
      .pipe(Effect.catchTag("SqlError", Effect.die));
  }
);

/** Consumes all three anonymous start budgets atomically, or changes no evidence. */
const admitBrowserPairingEmailStart = Effect.fn("EmailAuthentication.admitPairingStart")(
  function* (input: {
    pairingId: BrowserLoginPairingId;
    pairingExpiresAt: DateTime.Utc;
    normalizedAddress: string;
    sourceAddress: string;
    attemptedAt: DateTime.Utc;
  }) {
    const addressKey = yield* emailAuthenticationHmacKey(
      `browser-pairing-address:${input.normalizedAddress}`
    ).pipe(Effect.orDie);
    const sourceKey = yield* emailAuthenticationHmacKey(
      `browser-pairing-source:${input.sourceAddress}`
    ).pipe(Effect.orDie);
    const pairingKey = yield* emailAuthenticationHmacKey(
      `browser-pairing-id:${input.pairingId}`
    ).pipe(Effect.orDie);
    return yield* consumeAdmissionEvidence({
      attemptedAt: input.attemptedAt,
      scopes: [
        {
          key: addressKey,
          kind: "address",
          expiresAt: DateTime.add(input.attemptedAt, { hours: 24 }),
        },
        {
          key: sourceKey,
          kind: "source",
          expiresAt: DateTime.add(input.attemptedAt, { minutes: 10 }),
        },
        { key: pairingKey, kind: "pairing", expiresAt: input.pairingExpiresAt },
      ],
      checks: [
        {
          key: addressKey,
          startsAt: DateTime.subtract(input.attemptedAt, { hours: 24 }),
          maximumAttempts: maximumAddressStarts,
        },
        {
          key: pairingKey,
          startsAt: DateTime.subtract(input.attemptedAt, { hours: 24 }),
          maximumAttempts: maximumPairingStarts,
        },
        {
          key: sourceKey,
          startsAt: DateTime.subtract(input.attemptedAt, { minutes: 1 }),
          maximumAttempts: maximumSourceBurstStarts,
        },
        {
          key: sourceKey,
          startsAt: DateTime.subtract(input.attemptedAt, { minutes: 10 }),
          maximumAttempts: maximumSourceWindowStarts,
        },
      ],
    });
  }
);

const admitBrowserPairingEmailCompletionIngress = Effect.fn(
  "EmailAuthentication.admitPairingCompletionIngress"
)(function* (input: {
  pairingId: BrowserLoginPairingId;
  sourceAddress: string;
  attemptedAt: DateTime.Utc;
}) {
  const sourceKey = yield* emailAuthenticationHmacKey(
    `browser-pairing-completion-source:${input.sourceAddress}`
  ).pipe(Effect.orDie);
  const pairingKey = yield* emailAuthenticationHmacKey(
    `browser-pairing-completion-id:${input.pairingId}`
  ).pipe(Effect.orDie);
  const unresolvedAddressKey = yield* emailAuthenticationHmacKey(
    `browser-pairing-completion-unresolved-address:${input.pairingId}`
  ).pipe(Effect.orDie);
  const expiresAt = DateTime.add(input.attemptedAt, { minutes: 10 });
  return yield* consumeAdmissionEvidence({
    attemptedAt: input.attemptedAt,
    scopes: [
      { key: sourceKey, kind: "source", expiresAt },
      { key: pairingKey, kind: "pairing", expiresAt },
      { key: unresolvedAddressKey, kind: "address", expiresAt },
    ],
    checks: [
      {
        key: sourceKey,
        startsAt: DateTime.subtract(input.attemptedAt, { minutes: 1 }),
        maximumAttempts: maximumSourceBurstStarts,
      },
      {
        key: sourceKey,
        startsAt: DateTime.subtract(input.attemptedAt, { minutes: 10 }),
        maximumAttempts: maximumSourceWindowStarts,
      },
      {
        key: pairingKey,
        startsAt: DateTime.subtract(input.attemptedAt, { minutes: 10 }),
        maximumAttempts: maximumPairingStarts,
      },
      {
        key: unresolvedAddressKey,
        startsAt: DateTime.subtract(input.attemptedAt, { minutes: 10 }),
        maximumAttempts: maximumAddressStarts,
      },
    ],
  });
});

const admitBrowserPairingEmailCompletionOwner = Effect.fn(
  "EmailAuthentication.admitPairingCompletionOwner"
)(function* (owner: ResolvedWorkflowOwner, attemptedAt: DateTime.Utc) {
  // One VerifiedEmailCredential exists per User; this HMAC closes the real per-address budget
  // without projecting the mailbox out of its User-scoped workflow.
  const addressKey = yield* emailAuthenticationHmacKey(
    `browser-pairing-completion-address-owner:${owner.userId}`
  ).pipe(Effect.orDie);
  return yield* consumeAdmissionEvidence({
    attemptedAt,
    scopes: [
      { key: addressKey, kind: "address", expiresAt: DateTime.add(attemptedAt, { hours: 24 }) },
    ],
    checks: [
      {
        key: addressKey,
        startsAt: DateTime.subtract(attemptedAt, { hours: 24 }),
        maximumAttempts: maximumAddressStarts,
      },
    ],
  });
});

const ResolvedCredential = Schema.Struct({
  userId: UserId,
  credentialVerifiedAt: Schema.DateTimeUtcFromDate,
});
type ResolvedCredential = typeof ResolvedCredential.Type;

const credentialRevisionRemainsCurrent = Effect.fn(
  "EmailAuthentication.credentialRevisionRemainsCurrent"
)(function* (credential: ResolvedCredential) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ current: Schema.Boolean }),
    execute: () => sql`
      SELECT EXISTS (
        SELECT 1 FROM verified_email_credentials
        WHERE user_id = ${credential.userId}
          AND verified_at = ${credential.credentialVerifiedAt}
      ) AS current
    `,
  })(undefined).pipe(Effect.orDie);
  return result.current;
});

const BrowserPairingEmailWorkflowRowBase = BrowserPairingEmailWorkflowAwaitingDelivery.mapFields(
  Struct.omit(["_tag"])
)
  .mapFields(
    Struct.evolve({
      credentialVerifiedAt: () => Schema.DateTimeUtcFromDate,
      startedAt: () => Schema.DateTimeUtcFromDate,
      expiresAt: () => Schema.DateTimeUtcFromDate,
      resendAvailableAt: () => Schema.DateTimeUtcFromDate,
    })
  )
  .annotate({ identifier: "BrowserPairingEmailWorkflowRowBase" });

const ExistingWorkflow = BrowserPairingEmailWorkflowRowBase.mapFields(
  Struct.pick([
    "id",
    "credentialVerifiedAt",
    "deliveryGeneration",
    "resendAvailableAt",
    "expiresAt",
  ])
);
type ExistingWorkflow = typeof ExistingWorkflow.Type;

const findLockedWorkflow = Effect.fn("EmailAuthentication.findLockedPairingWorkflow")(function* (
  pairingId: BrowserLoginPairingId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: BrowserLoginPairingId,
    Result: ExistingWorkflow,
    execute: (id) => sql`
        SELECT id, credential_verified_at AS "credentialVerifiedAt",
          delivery_generation AS "deliveryGeneration",
          resend_available_at AS "resendAvailableAt", expires_at AS "expiresAt"
        FROM browser_pairing_email_workflows WHERE pairing_id = ${id} FOR UPDATE
      `,
  })(pairingId).pipe(Effect.orDie);
});

const makePublicCode = Effect.fn(function* () {
  const crypto = yield* Crypto.Crypto;
  return EmailVerificationPublicCode.make(
    formatEmailCode({
      symbols: selectEmailCodeSymbols({
        bytes: yield* crypto.randomBytes(publicSymbolCount).pipe(Effect.orDie),
        maximum: publicSymbolCount,
      }),
      groupSize,
    })
  );
});

const persistDeliveryGeneration = Effect.fn("EmailAuthentication.persistPairingDeliveryGeneration")(
  function* (input: {
    credential: ResolvedCredential;
    email: EmailAddress;
    pairingId: BrowserLoginPairingId;
    pairingExpiresAt: DateTime.Utc;
    requestedAt: DateTime.Utc;
    existing: Option.Option<ExistingWorkflow>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const publicCode = yield* makePublicCode();
    if (Option.isNone(input.existing)) {
      const id = BrowserPairingEmailWorkflowId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
      const inserted = yield* sql`
      INSERT INTO browser_pairing_email_workflows (
        id, user_id, pairing_id, credential_verified_at, public_code, started_at, expires_at,
        delivery_generation, resend_available_at
      ) VALUES (
        ${id}, ${input.credential.userId}, ${input.pairingId},
        ${input.credential.credentialVerifiedAt}, ${publicCode}, ${input.requestedAt},
        ${input.pairingExpiresAt}, 1, ${resendAvailability(input.requestedAt)}
      ) ON CONFLICT (pairing_id) DO NOTHING RETURNING id
    `.pipe(Effect.orDie);
      if (inserted.length === 0) return;
      const intentId = EmailDeliveryIntentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
      yield* sql`
      INSERT INTO browser_pairing_email_delivery_intents (
        id, workflow_id, generation, email_address, status, idempotency_key, created_at
      ) VALUES (${intentId}, ${id}, 1, ${input.email}, 'pending', ${intentId}, ${input.requestedAt})
    `.pipe(Effect.orDie);
      return;
    }

    const workflowId = input.existing.value.id;
    yield* sql`
    UPDATE browser_pairing_email_delivery_intents SET status = 'superseded',
      claim_token = NULL, claim_expires_at = NULL
    WHERE workflow_id = ${workflowId} AND status <> 'superseded'
  `.pipe(Effect.orDie);
    yield* sql`
    UPDATE browser_pairing_email_workflows SET public_code = ${publicCode},
      delivery_generation = delivery_generation + 1,
      resend_available_at = ${resendAvailability(input.requestedAt)}, proof_digest = NULL,
      proof_expires_at = NULL, wrong_proof_attempts = 0
    WHERE id = ${workflowId}
  `.pipe(Effect.orDie);
    const intentId = EmailDeliveryIntentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    yield* sql`
    INSERT INTO browser_pairing_email_delivery_intents (
      id, workflow_id, generation, email_address, status, idempotency_key, created_at
    ) SELECT ${intentId}, id, delivery_generation, ${input.email}, 'pending', ${intentId},
      ${input.requestedAt} FROM browser_pairing_email_workflows WHERE id = ${workflowId}
  `.pipe(Effect.orDie);
  }
);

const startForResolvedCredentialInScope = Effect.fn(
  "EmailAuthentication.startForResolvedCredentialInScope"
)(function* (input: {
  credential: ResolvedCredential;
  email: EmailAddress;
  pairingId: BrowserLoginPairingId;
  requestedAt: DateTime.Utc;
  processedAt: DateTime.Utc;
}) {
  if (!(yield* credentialRevisionRemainsCurrent(input.credential))) return;
  const checked = yield* lockPendingBrowserLoginPairingInScope(input.pairingId, input.processedAt);
  if (Option.isNone(checked)) return;
  const existing = yield* findLockedWorkflow(checked.value.pairingId);
  const decision = decideBrowserPairingEmailRequest({
    existing: Option.map(existing, (workflow) => ({
      ...workflow,
      credentialRevisionMatches:
        DateTime.toEpochMillis(workflow.credentialVerifiedAt) ===
        DateTime.toEpochMillis(input.credential.credentialVerifiedAt),
    })),
    requestedAt: input.requestedAt,
    processedAt: input.processedAt,
  });
  if (decision === "Reject") return;
  if (
    !(yield* admitEmailDeliveryInScope({
      requester: { _tag: "User", userId: input.credential.userId },
      recipient: input.email,
      attemptedAt: input.requestedAt,
    }))
  ) {
    return;
  }
  yield* persistDeliveryGeneration({
    credential: input.credential,
    email: input.email,
    pairingId: checked.value.pairingId,
    pairingExpiresAt: checked.value.expiresAt,
    requestedAt: input.requestedAt,
    existing,
  });
});

/** Starts a non-enumerating email approval attempt for one already-proved live pairing. */
export const requestBrowserPairingEmailCode = Effect.fn("EmailAuthentication.startBrowserPairing")(
  function* (input: {
    pairingId: unknown;
    privateVerifier: unknown;
    email: unknown;
    sourceAddress: string;
  }) {
    const attemptedAt = yield* DateTime.now;
    const checked = yield* checkBrowserLoginPrivateVerifier({ ...input, attemptedAt });
    if (Option.isNone(checked)) return yield* new BrowserLoginPairingInvalid();
    yield* Effect.gen(function* () {
      const normalizedAddress = normalizedAdmissionAddress(input.email);
      if (
        !(yield* admitBrowserPairingEmailStart({
          pairingId: checked.value.pairingId,
          pairingExpiresAt: checked.value.expiresAt,
          normalizedAddress,
          sourceAddress: input.sourceAddress,
          attemptedAt,
        }))
      ) {
        return;
      }
      const decodedEmail = decodeEmailAddress(input.email);
      if (Result.isFailure(decodedEmail)) return;
      const sql = yield* SqlClient.SqlClient;
      const crypto = yield* Crypto.Crypto;
      const requestId = BrowserPairingEmailStartRequestId.make(
        yield* crypto.randomUUIDv7.pipe(Effect.orDie)
      );
      const addressLookupKey = yield* emailCredentialLookupKey(decodedEmail.success).pipe(
        Effect.orDie
      );
      yield* sql`
      INSERT INTO browser_pairing_email_start_requests (
        id, pairing_id, address_lookup_key, requested_at, expires_at, status
      ) VALUES (
        ${requestId}, ${checked.value.pairingId}, ${addressLookupKey}, ${attemptedAt},
        ${checked.value.expiresAt}, 'pending'
      )
    `.pipe(Effect.orDie);
    }).pipe(Effect.timeoutOption(startWorkDeadlineMilliseconds));
    const releaseAt = DateTime.toEpochMillis(attemptedAt) + startResponseReleaseMilliseconds;
    const remainingDelay = releaseAt - DateTime.toEpochMillis(yield* DateTime.now);
    if (remainingDelay > 0) yield* Effect.sleep(remainingDelay);
    return {
      status: "pending" as const,
      retryAfterSeconds: browserPairingEmailRetryAfterSeconds,
    };
  }
);

const StartRequestGatewayOutcome = Schema.Struct({
  requestId: BrowserPairingEmailStartRequestId,
  userId: Schema.OptionFromNullOr(UserId),
  claimToken: Schema.OptionFromNullOr(BrowserPairingEmailStartRequestClaimToken),
});
type ClaimedStartRequest = Readonly<{
  requestId: BrowserPairingEmailStartRequestId;
  userId: UserId;
  claimToken: BrowserPairingEmailStartRequestClaimToken;
}>;

const claimNextStartRequest = Effect.fn("EmailAuthentication.claimNextPairingStartRequest")(
  function* (claimedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const claimToken = BrowserPairingEmailStartRequestClaimToken.make(
      yield* crypto.randomUUIDv7.pipe(Effect.orDie)
    );
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: StartRequestGatewayOutcome,
      execute: () => sql`
        SELECT request_id AS "requestId", user_id AS "userId", claim_token AS "claimToken"
        FROM fidy_claim_browser_pairing_email_start_request(
          ${claimedAt}, ${claimToken}, ${DateTime.add(claimedAt, { minutes: 2 })}
        )
      `,
    })(undefined).pipe(Effect.orDie);
  }
);

const ResolvedStartRequest = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  email: EmailAddress,
  credentialVerifiedAt: Schema.DateTimeUtcFromDate,
  requestedAt: Schema.DateTimeUtcFromDate,
});
type ResolvedStartRequest = typeof ResolvedStartRequest.Type;

const findClaimedStartRequestInScope = Effect.fn(
  "EmailAuthentication.findClaimedPairingStartRequestInScope"
)(function* (claim: ClaimedStartRequest) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ResolvedStartRequest,
    execute: () => sql`
      SELECT request.pairing_id AS "pairingId", credential.email_address AS email,
        credential.verified_at AS "credentialVerifiedAt", request.requested_at AS "requestedAt"
      FROM browser_pairing_email_start_requests request
      JOIN verified_email_credential_authentication_lookups lookup
        ON lookup.user_id = request.user_id
        AND lookup.authentication_lookup_key = request.address_lookup_key
      JOIN verified_email_credentials credential ON credential.user_id = lookup.user_id
      WHERE request.id = ${claim.requestId} AND request.user_id = ${claim.userId}
        AND request.status = 'claimed' AND request.claim_token = ${claim.claimToken}
      FOR UPDATE OF request
    `,
  })(undefined).pipe(Effect.orDie);
});

const deleteClaimedStartRequestInScope = Effect.fn(
  "EmailAuthentication.deleteClaimedPairingStartRequestInScope"
)(function* (claim: ClaimedStartRequest) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM browser_pairing_email_start_requests
    WHERE id = ${claim.requestId} AND user_id = ${claim.userId}
      AND status = 'claimed' AND claim_token = ${claim.claimToken}
  `.pipe(Effect.orDie);
});

const processClaimedStartRequestInScope = Effect.fn(
  "EmailAuthentication.processClaimedPairingStartRequestInScope"
)(function* (claim: ClaimedStartRequest, processedAt: DateTime.Utc) {
  const request = yield* findClaimedStartRequestInScope(claim);
  yield* Option.match(request, {
    onNone: () => Effect.void,
    onSome: (claimedRequest) =>
      startForResolvedCredentialInScope({
        credential: {
          userId: claim.userId,
          credentialVerifiedAt: claimedRequest.credentialVerifiedAt,
        },
        email: claimedRequest.email,
        pairingId: claimedRequest.pairingId,
        requestedAt: claimedRequest.requestedAt,
        processedAt,
      }),
  });
  yield* deleteClaimedStartRequestInScope(claim);
});

/** Advances at most one HMAC-only request into a User-owned delivery workflow. */
export const processNextBrowserPairingEmailStartRequest = Effect.fn(
  "EmailAuthentication.processNextPairingStartRequest"
)(function* () {
  const processedAt = yield* DateTime.now;
  const claim = yield* claimNextStartRequest(processedAt);
  if (Option.isNone(claim)) return false;
  if (Option.isNone(claim.value.userId) || Option.isNone(claim.value.claimToken)) return true;
  const claimed = {
    requestId: claim.value.requestId,
    userId: claim.value.userId.value,
    claimToken: claim.value.claimToken.value,
  } satisfies ClaimedStartRequest;
  yield* withUserTransaction(
    claimed.userId,
    withSubjectLockInScope(
      claimed.userId,
      withUserLockInScope(
        advisoryLockKey.browserLoginApproval(claimed.userId),
        processClaimedStartRequestInScope(claimed, processedAt)
      )
    )
  );
  return true;
});

const ResolvedWorkflowOwner = Schema.Struct({
  workflowId: BrowserPairingEmailWorkflowId,
  userId: UserId,
  expiresAt: Schema.DateTimeUtcFromDate,
});
type ResolvedWorkflowOwner = typeof ResolvedWorkflowOwner.Type;

const resolveWorkflowOwner = Effect.fn("EmailAuthentication.resolvePairingWorkflowOwner")(
  function* (pairingId: BrowserLoginPairingId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: BrowserLoginPairingId,
      Result: ResolvedWorkflowOwner,
      execute: (id) => sql`
        SELECT workflow_id AS "workflowId", user_id AS "userId", expires_at AS "expiresAt"
        FROM fidy_resolve_browser_pairing_email_workflow_owner(${id})
      `,
    })(pairingId).pipe(Effect.orDie);
  }
);

const CompletionWorkflow = BrowserPairingEmailWorkflowRowBase.mapFields(
  Struct.pick(["id", "credentialVerifiedAt", "publicCode", "wrongProofAttempts", "expiresAt"])
).pipe(
  Schema.fieldsAssign({
    proofDigest: Schema.OptionFromNullOr(EmailVerificationDigest),
    proofExpiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  })
);
type CompletionWorkflow = typeof CompletionWorkflow.Type;

const findCompletionWorkflow = Effect.fn("EmailAuthentication.findPairingCompletionWorkflow")(
  function* (workflowId: BrowserPairingEmailWorkflowId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: CompletionWorkflow,
      execute: () => sql`
        SELECT id, credential_verified_at AS "credentialVerifiedAt", public_code AS "publicCode",
          proof_digest AS "proofDigest", proof_expires_at AS "proofExpiresAt",
          wrong_proof_attempts AS "wrongProofAttempts", expires_at AS "expiresAt"
        FROM browser_pairing_email_workflows
        WHERE id = ${workflowId} FOR UPDATE
      `,
    })(undefined).pipe(Effect.orDie);
  }
);

export const digestBrowserPairingEmailProof = Effect.fn("EmailAuthentication.digestPairingProof")(
  function* (pairingId: BrowserLoginPairingId, proof: EmailVerificationProof) {
    const crypto = yield* Crypto.Crypto;
    return yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(`browser-pairing-approval\u0000${pairingId}\u0000${proof}`)
      )
      .pipe(Effect.orDie);
  }
);

const applyCompletionProofAttempt = Effect.fn("EmailAuthentication.applyPairingCompletionProof")(
  function* (
    workflow: CompletionWorkflow,
    input: Readonly<{
      pairingId: BrowserLoginPairingId;
      code: string;
      attemptedAt: DateTime.Utc;
    }>
  ) {
    const sql = yield* SqlClient.SqlClient;
    if (Option.isNone(workflow.proofDigest) || Option.isNone(workflow.proofExpiresAt)) return false;
    const digest = yield* digestBrowserPairingEmailProof(
      input.pairingId,
      EmailVerificationProof.make(input.code.slice(proofOffset))
    );
    const decision = yield* decideProofAttempt({
      digestMatches:
        input.code.startsWith(`${workflow.publicCode}-`) &&
        digest.length === workflow.proofDigest.value.length &&
        timingSafeEqual(digest, workflow.proofDigest.value),
      wrongAttempts: workflow.wrongProofAttempts,
      proofExpiresAt: workflow.proofExpiresAt.value,
      enrollmentExpiresAt: workflow.expiresAt,
      attemptedAt: input.attemptedAt,
    });
    if (decision._tag === "Accept") return true;
    if (decision._tag === "Wrong") {
      yield* sql`
      UPDATE browser_pairing_email_workflows SET wrong_proof_attempts = ${decision.wrongAttempts}
      WHERE id = ${workflow.id}
    `.pipe(Effect.orDie);
      return false;
    }
    if (decision._tag === "Expired") {
      yield* sql`
      UPDATE browser_pairing_email_workflows SET proof_digest = NULL, proof_expires_at = NULL
      WHERE id = ${workflow.id}
    `.pipe(Effect.orDie);
      return false;
    }
    yield* sql`DELETE FROM browser_pairing_email_workflows WHERE id = ${workflow.id}`.pipe(
      Effect.orDie
    );
    return false;
  }
);

const completeForResolvedOwnerInScope = Effect.fn(
  "EmailAuthentication.completeForResolvedOwnerInScope"
)(function* (input: {
  owner: ResolvedWorkflowOwner;
  pairingId: BrowserLoginPairingId;
  privateVerifier: unknown;
  combinedCode: Redacted.Redacted<EmailVerificationCode>;
  attemptedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* acquireEmailVerificationAdmissionInScope())) return false;
  const checked = yield* checkBrowserLoginPrivateVerifierInScope(input);
  if (Option.isNone(checked)) return false;
  const code = Redacted.value(input.combinedCode);
  const workflow = yield* findCompletionWorkflow(input.owner.workflowId);
  if (Option.isNone(workflow)) return false;
  const currentCredential = yield* credentialRevisionRemainsCurrent({
    userId: input.owner.userId,
    credentialVerifiedAt: workflow.value.credentialVerifiedAt,
  });
  if (!currentCredential) {
    yield* sql`DELETE FROM browser_pairing_email_workflows WHERE id = ${workflow.value.id}`.pipe(
      Effect.orDie
    );
    return false;
  }
  if (
    !(yield* applyCompletionProofAttempt(workflow.value, {
      pairingId: input.pairingId,
      code,
      attemptedAt: input.attemptedAt,
    }))
  ) {
    return false;
  }
  const approved = yield* approveBrowserLoginPairingWithPrivateVerifierInScope({
    pairingId: input.pairingId,
    privateVerifier: input.privateVerifier,
    userId: input.owner.userId,
    attemptedAt: input.attemptedAt,
  }).pipe(Effect.catchTag("BrowserLoginPairingApprovalRejected", () => Effect.succeed(false)));
  yield* Effect.when(Effect.succeed(approved))(
    sql`DELETE FROM browser_pairing_email_workflows WHERE id = ${workflow.value.id}`.pipe(
      Effect.orDie
    )
  );
  return approved;
});

/** Consumes one current combined code and approves, but does not redeem, the existing pairing. */
export const submitBrowserPairingEmailCode = Effect.fn(
  "EmailAuthentication.completeBrowserPairing"
)(function* (input: {
  pairingId: unknown;
  privateVerifier: unknown;
  combinedCode: Redacted.Redacted<EmailVerificationCode>;
  sourceAddress: string;
}) {
  const attemptedAt = yield* DateTime.now;
  const pairingId = Schema.decodeUnknownOption(BrowserLoginPairingId)(input.pairingId);
  if (Option.isNone(pairingId)) return false;
  if (
    !(yield* admitBrowserPairingEmailCompletionIngress({
      pairingId: pairingId.value,
      sourceAddress: input.sourceAddress,
      attemptedAt,
    }))
  ) {
    return false;
  }
  const owner = yield* resolveWorkflowOwner(pairingId.value);
  if (Option.isNone(owner)) return false;
  if (!(yield* admitBrowserPairingEmailCompletionOwner(owner.value, attemptedAt))) {
    return false;
  }
  return yield* withUserTransaction(
    owner.value.userId,
    withSubjectLockInScope(
      owner.value.userId,
      withUserLockInScope(
        advisoryLockKey.browserLoginApproval(owner.value.userId),
        completeForResolvedOwnerInScope({
          ...input,
          owner: owner.value,
          pairingId: pairingId.value,
          attemptedAt,
        })
      )
    )
  );
});
