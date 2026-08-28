import { timingSafeEqual } from "node:crypto";
import { Crypto, Data, DateTime, Effect, Option, Redacted } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import type { UserId } from "~/core/identity/reference";
import type { WebSessionId } from "~/core/web-session/reference";
import {
  BackupRecoveryCode,
  BackupRecoveryDigest,
  type SupportOperatorId,
  SupportRecoveryCaseEventId,
  SupportRecoveryCaseId,
} from "~/core/recovery/model";
import {
  advisoryLockKey,
  tryWithUserLockInScope,
  withUserLockInScope,
} from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { UserActionRequired } from "~/shell/_shared/errors";
import { withSubjectLockInScope } from "~/shell/consent/repo";
import {
  approveBrowserLoginPairingForExistingUserInScope,
  isBrowserLoginPairingApprovableInScope,
} from "~/shell/browser-login/service";
import {
  type OpenSupportRecoveryCase,
  type ResolvedSupportRecovery,
  approveSupportRecoveryCase,
  expireSupportRecoveryCase,
  findOpenSupportRecoveryCase,
  hasOpenCaseCapacity,
  hasSupportRecoveryCaseForPairing,
  insertSupportRecoveryCase,
  lockBackupRecoveryCredential,
  rejectSupportRecoveryCase,
  resolveAttributedSupportRecovery,
  resolveSupportRecovery,
  rotateBackupRecoveryDigestInScope,
} from "./repo";

const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const recoverySymbolCount = 25;
const recoveryGroupSize = 5;
const recoveryAlphabetMask = 31;

/** Expected claimant-neutral decision returned by the one deep support interface. */
export type ApproveSupportRecoveryOutcome = "Approved" | "NotApproved";

/** Operator-safe failure when support recovery cannot make a reliable decision. */
export class SupportRecoveryOperationalFailure extends Data.TaggedError(
  "SupportRecoveryOperationalFailure"
)<{ readonly code: "support_recovery_unavailable" }> {}

/** Checked values accepted only after the private transport has authenticated and decoded them. */
export type ApproveSupportRecoveryInput = Readonly<{
  operatorId: SupportOperatorId;
  pairingCode: BrowserLoginPublicCode;
  backupRecoveryCode: Redacted.Redacted<BackupRecoveryCode>;
}>;

const digestRecoveryCode = Effect.fn("Recovery.digestCode")(function* (code: string) {
  const crypto = yield* Crypto.Crypto;
  return BackupRecoveryDigest.make(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(code)).pipe(Effect.orDie)
  );
});

/** Generates one uniformly selected code and its checked digest through application Crypto. */
export const generateBackupRecoveryMaterial = Effect.fn("Recovery.generateMaterial")(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(recoverySymbolCount).pipe(Effect.orDie);
  let symbols = "";
  for (const byte of bytes) symbols += recoveryAlphabet[byte & recoveryAlphabetMask];
  const groups = Array.from({ length: recoverySymbolCount / recoveryGroupSize }, (_, index) =>
    symbols.slice(index * recoveryGroupSize, (index + 1) * recoveryGroupSize)
  );
  const code = BackupRecoveryCode.make(groups.join("-"));
  return {
    code: Redacted.make(code),
    digest: yield* digestRecoveryCode(code),
  };
});

const makeEventId = Effect.fn("Recovery.makeEventId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return SupportRecoveryCaseEventId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
});

const rejectCase = Effect.fn("Recovery.rejectLockedCase")(function* (
  recoveryCase: OpenSupportRecoveryCase,
  operatorId: SupportOperatorId,
  rejectedAt: DateTime.Utc
) {
  yield* rejectSupportRecoveryCase({
    rejectionEventId: yield* makeEventId(),
    refusalEventId: yield* makeEventId(),
    recoveryCase,
    operatorId,
    rejectedAt,
  });
  return "NotApproved" as const;
});

const openCase = Effect.fn("Recovery.openCase")(function* (input: {
  candidate: ResolvedSupportRecovery;
  operatorId: SupportOperatorId;
  openedAt: DateTime.Utc;
}) {
  if (yield* hasSupportRecoveryCaseForPairing(input.candidate.pairingId)) {
    return Option.none<OpenSupportRecoveryCase>();
  }
  if (!(yield* hasOpenCaseCapacity())) {
    return yield* new SupportRecoveryOperationalFailure({
      code: "support_recovery_unavailable",
    });
  }
  const crypto = yield* Crypto.Crypto;
  return Option.some(
    yield* insertSupportRecoveryCase({
      id: SupportRecoveryCaseId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
      eventId: yield* makeEventId(),
      userId: input.candidate.userId,
      pairingId: input.candidate.pairingId,
      credentialRevision: input.candidate.credentialRevision,
      operatorId: input.operatorId,
      openedAt: input.openedAt,
      expiresAt: input.candidate.pairingExpiresAt,
    })
  );
});

const currentCase = Effect.fn("Recovery.currentCase")(function* (input: {
  candidate: ResolvedSupportRecovery;
  operatorId: SupportOperatorId;
  attemptedAt: DateTime.Utc;
}) {
  const existing = yield* findOpenSupportRecoveryCase(input.candidate.userId);
  if (Option.isSome(existing)) {
    if (DateTime.isGreaterThanOrEqualTo(input.attemptedAt, existing.value.expiresAt)) {
      yield* expireSupportRecoveryCase({
        eventId: yield* makeEventId(),
        recoveryCase: existing.value,
      });
    } else {
      return Option.some(existing.value);
    }
  }
  return yield* openCase({
    candidate: input.candidate,
    operatorId: input.operatorId,
    openedAt: input.attemptedAt,
  });
});

const credentialMatchesCandidate = (
  credential: Effect.Success<ReturnType<typeof lockBackupRecoveryCredential>>,
  attemptedDigest: BackupRecoveryDigest,
  expectedRevision: number
): boolean =>
  Option.match(credential, {
    onNone: () => false,
    onSome: ({ codeDigest, revision }) =>
      Option.match(codeDigest, {
        onNone: () => false,
        onSome: (digest) =>
          timingSafeEqual(attemptedDigest, digest) && revision === expectedRevision,
      }),
  });

const currentCaseForApprovablePairing = Effect.fn("Recovery.currentCaseForApprovablePairing")(
  function* (input: Parameters<typeof currentCase>[0]) {
    const approvable = yield* isBrowserLoginPairingApprovableInScope(
      input.candidate.pairingId,
      input.attemptedAt
    );
    if (approvable) return yield* currentCase(input);
    // Resolution only locates the transaction's User. A pairing that stopped being approvable
    // while this invocation waited for the User locks is no longer attributable to an open case.
    return Option.none<OpenSupportRecoveryCase>();
  }
);

class SupportRecoveryAttributionLost extends Data.TaggedError(
  "SupportRecoveryAttributionLost"
)<{}> {}

const caseMatchesCandidate = (
  recoveryCase: OpenSupportRecoveryCase,
  candidate: ResolvedSupportRecovery
): boolean =>
  recoveryCase.pairingId === candidate.pairingId &&
  recoveryCase.credentialRevision === candidate.credentialRevision;

type SupportRecoveryDecisionInput = Readonly<{
  candidate: ResolvedSupportRecovery;
  attemptedDigest: BackupRecoveryDigest;
  operatorId: SupportOperatorId;
  attemptedAt: DateTime.Utc;
  caseAlreadyExists: boolean;
}>;

const rejectAttributedCredentialMismatch = Effect.fn("Recovery.rejectAttributedCredentialMismatch")(
  function* (input: SupportRecoveryDecisionInput) {
    if (!input.caseAlreadyExists) return "NotApproved" as const;
    const attributedCase = yield* currentCaseForApprovablePairing(input);
    if (Option.isNone(attributedCase)) return "NotApproved" as const;
    const trackedCase = attributedCase.value;
    return caseMatchesCandidate(trackedCase, input.candidate)
      ? yield* rejectCase(trackedCase, input.operatorId, input.attemptedAt)
      : ("NotApproved" as const);
  }
);

const decideInUserScope = Effect.fn("Recovery.decideInUserScope")(function* (
  input: SupportRecoveryDecisionInput
) {
  const credential = yield* lockBackupRecoveryCredential(input.candidate.userId);
  const credentialMatches = credentialMatchesCandidate(
    credential,
    input.attemptedDigest,
    input.candidate.credentialRevision
  );
  // A valid pairing reference becomes attributable after its case opens even when this credential
  // proof is wrong, stale, or belongs to another User. The event retains no matching detail.
  if (!credentialMatches) return yield* rejectAttributedCredentialMismatch(input);

  const recoveryCase = yield* currentCaseForApprovablePairing(input);
  if (Option.isNone(recoveryCase)) return "NotApproved";
  const lockedCase = recoveryCase.value;
  if (!caseMatchesCandidate(lockedCase, input.candidate)) {
    return yield* rejectCase(lockedCase, input.operatorId, input.attemptedAt);
  }

  const pairingApproval = yield* approveBrowserLoginPairingForExistingUserInScope({
    userId: input.candidate.userId,
    pairingId: input.candidate.pairingId,
    attemptedAt: input.attemptedAt,
  });
  // A false authoritative owner transition after case creation must fail the transaction so its
  // provisional open evidence rolls back before this is mapped to the claimant-neutral outcome.
  if (Option.isNone(pairingApproval)) return yield* new SupportRecoveryAttributionLost();

  yield* approveSupportRecoveryCase({
    eventId: yield* makeEventId(),
    recoveryCase: lockedCase,
    userId: input.candidate.userId,
    operatorId: input.operatorId,
    approvedAt: pairingApproval.value,
  });
  return "Approved" as const;
});

/** Runs the transactional decision before boundary-safe failure normalization. */
const approveSupportRecoveryDecision = Effect.fn("Recovery.approveSupportRecoveryDecision")(
  function* (
    input: ApproveSupportRecoveryInput
  ): Effect.fn.Return<
    ApproveSupportRecoveryOutcome,
    SupportRecoveryOperationalFailure | SupportRecoveryAttributionLost,
    Crypto.Crypto | SqlClient.SqlClient
  > {
    const attemptedDigest = yield* digestRecoveryCode(Redacted.value(input.backupRecoveryCode));
    const attributedCandidate = yield* resolveAttributedSupportRecovery(input.pairingCode);
    const candidate = Option.isSome(attributedCandidate)
      ? attributedCandidate
      : yield* resolveSupportRecovery(attemptedDigest, input.pairingCode);
    if (Option.isNone(candidate)) return "NotApproved";
    const attemptedAt = yield* DateTime.now;
    return yield* withUserTransaction(
      candidate.value.userId,
      withSubjectLockInScope(
        candidate.value.userId,
        withUserLockInScope(
          advisoryLockKey.browserLoginApproval(candidate.value.userId),
          decideInUserScope({
            candidate: candidate.value,
            attemptedDigest,
            operatorId: input.operatorId,
            attemptedAt,
            caseAlreadyExists: Option.isSome(attributedCandidate),
          })
        )
      )
    );
  }
);

/**
 * Verifies one pre-issued BackupRecoveryCode and approves an existing pairing in one transaction.
 * Unattributable input returns the same decision and creates no User-owned evidence.
 */
export const approveSupportRecovery = Effect.fn("Recovery.approveSupportRecovery")(function* (
  input: ApproveSupportRecoveryInput
): Effect.fn.Return<
  ApproveSupportRecoveryOutcome,
  SupportRecoveryOperationalFailure,
  Crypto.Crypto | SqlClient.SqlClient
> {
  return yield* approveSupportRecoveryDecision(input).pipe(
    Effect.catchTag("SupportRecoveryAttributionLost", () => Effect.succeed("NotApproved" as const)),
    Effect.catchDefect(() =>
      Effect.fail(new SupportRecoveryOperationalFailure({ code: "support_recovery_unavailable" }))
    )
  );
});

/** Replaces the current credential under the canonical caller-owned User transaction. */
export const rotateBackupRecoveryCode = Effect.fn("Recovery.rotateBackupRecoveryCode")(function* (
  userId: UserId,
  webSessionId: WebSessionId
) {
  const rotated = yield* withSubjectLockInScope(
    userId,
    tryWithUserLockInScope(
      advisoryLockKey.backupRecoveryRotation(userId),
      Effect.gen(function* () {
        const rotatedAt = yield* DateTime.now;
        const material = yield* generateBackupRecoveryMaterial();
        yield* lockBackupRecoveryCredential(userId);
        const installed = yield* rotateBackupRecoveryDigestInScope({
          userId,
          webSessionId,
          codeDigest: material.digest,
          rotatedAt,
        });
        return installed
          ? Option.some({
              status: "rotated" as const,
              backupRecoveryCode: material.code,
              rotatedAt,
            })
          : Option.none();
      })
    )
  );
  if (Option.isSome(rotated) && Option.isSome(rotated.value)) return rotated.value.value;
  return yield* UserActionRequired.make({
    error: {
      code: "user_action_required",
      message: "Otra rotación ya está en curso. Espera y vuelve a intentarlo.",
    },
    next: [],
  });
});
