import { Crypto, Data, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { HostedAgentSession, HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import {
  currentOnboardingGrantInScope,
  isOnboardingGrantUnrevokedInScope,
  onboardingConsentStandingInScope,
  withSubjectLock,
} from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";

const hostedAgentSessionIdleDuration = "15 minutes";

const HostedAgentSessionRow = Schema.Struct({
  id: HostedAgentSessionId,
  subjectUserId: UserId,
  consentGrantId: ConsentRecordId,
  disclosureRevision: HostedAgentSession.fields.consentBasis.fields.disclosureRevision,
  disclosureSha256: HostedAgentSession.fields.consentBasis.fields.disclosureSha256,
  policyRevision: HostedAgentSession.fields.consentBasis.fields.policyRevision,
  policySha256: HostedAgentSession.fields.consentBasis.fields.policySha256,
  status: HostedAgentSession.fields.status,
  startedAt: Schema.DateTimeUtcFromDate,
  lastTerminalTurnAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  latestPendingTurnAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});

type HostedAgentSessionRow = typeof HostedAgentSessionRow.Type;

const fromRow = (row: HostedAgentSessionRow): HostedAgentSession =>
  HostedAgentSession.make({
    id: row.id,
    subjectUserId: row.subjectUserId,
    consentBasis: {
      grantId: row.consentGrantId,
      disclosureRevision: row.disclosureRevision,
      disclosureSha256: row.disclosureSha256,
      policyRevision: row.policyRevision,
      policySha256: row.policySha256,
    },
    startedAt: row.startedAt,
    lastTerminalTurnAt: row.lastTerminalTurnAt,
    status: row.status,
  });

/** Safe admission failure requiring the User to act on a Fidy-owned surface. */
export class HostedAgentSessionConsentRequired extends Data.TaggedError(
  "HostedAgentSessionConsentRequired"
)<{ readonly userId: UserId }> {}

const activeSessionInScope = Effect.fn("HostedAgentSession.activeInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: HostedAgentSessionRow,
    execute: (subjectUserId) => sql`
      SELECT session.id, session.user_id AS "subjectUserId",
        session.consent_grant_id AS "consentGrantId",
        session.disclosure_revision AS "disclosureRevision",
        session.disclosure_sha256 AS "disclosureSha256",
        session.policy_revision AS "policyRevision",
        session.policy_sha256 AS "policySha256", session.status,
        session.started_at AS "startedAt",
        session.last_terminal_turn_at AS "lastTerminalTurnAt",
        (SELECT max(turn.started_at) FROM conversation_turns AS turn
          WHERE turn.user_id = session.user_id AND turn.session_id = session.id
            AND turn.state = 'Pending') AS "latestPendingTurnAt"
      FROM hosted_agent_sessions AS session
      WHERE session.user_id = ${subjectUserId} AND session.status = 'active'
      FOR UPDATE
    `,
  })(userId).pipe(Effect.orDie);
});

const makeSessionId = Effect.fn("HostedAgentSession.makeId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return HostedAgentSessionId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
});

/**
 * A session carries work only while both its captured grant and the User's current onboarding
 * Consent stand. The captured check closes a session whose admitting basis was revoked, even after a
 * later re-grant; the standing check is the predicate the PAT seam applies, so no credential keeps
 * working through a revocation the other one honors.
 */
const sessionConsentStandsInScope = Effect.fn("HostedAgentSession.consentStands")(function* (
  userId: UserId,
  capturedGrantId: ConsentRecordId
) {
  if (!(yield* isOnboardingGrantUnrevokedInScope(userId, capturedGrantId))) return false;
  return (yield* onboardingConsentStandingInScope(userId)) === "granted";
});

/**
 * Whether one admitted session may still carry work, judged from the basis it captured. A session a
 * terms revision superseded still stands, because the captured basis governs the session it was
 * captured for; only revocation takes it away. Compaction reads this rather than current terms.
 */
export const hostedAgentSessionConsentStandsInScope = Effect.fn(
  "HostedAgentSession.consentStandsInScope"
)(function* (userId: UserId, hostedAgentSessionId: HostedAgentSessionId) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
    Result: Schema.Struct({ consentGrantId: ConsentRecordId }),
    execute: (owned) => sql`
      SELECT consent_grant_id AS "consentGrantId"
      FROM hosted_agent_sessions
      WHERE user_id = ${owned.userId} AND id = ${owned.hostedAgentSessionId}
        AND status = 'active'
    `,
  })({ userId, hostedAgentSessionId }).pipe(Effect.orDie);
  if (Option.isNone(row)) return false;
  return yield* sessionConsentStandsInScope(userId, row.value.consentGrantId);
});

/** Requires one captured session to remain active and explicitly unrevoked in the current lock. */
export const requireHostedAgentSessionInScope = Effect.fn("HostedAgentSession.requireInScope")(
  function* (userId: UserId, hostedAgentSessionId: HostedAgentSessionId) {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
      Result: Schema.Struct({ consentGrantId: ConsentRecordId }),
      execute: (owned) => sql`
      SELECT consent_grant_id AS "consentGrantId"
      FROM hosted_agent_sessions
      WHERE user_id = ${owned.userId} AND id = ${owned.hostedAgentSessionId}
        AND status = 'active'
      FOR UPDATE
    `,
    })({ userId, hostedAgentSessionId }).pipe(Effect.orDie);
    if (Option.isNone(row)) return yield* new HostedAgentSessionConsentRequired({ userId });
    if (yield* sessionConsentStandsInScope(userId, row.value.consentGrantId)) return;
    // Only refuses: a close written here would roll back with the refusal that follows it in the
    // same transaction. The caller commits the close separately.
    return yield* new HostedAgentSessionConsentRequired({ userId });
  }
);

/**
 * Rechecks explicit revocation without comparing the captured basis to current terms. A refusal
 * closes the session in its own committed transaction, because the refusal rolls its own back: a
 * User who revokes and never messages again must not leave a session that still reads as active.
 * The Pending Turn it may hold is untouched, so already-admitted work keeps its durable evidence.
 */
export const requireHostedAgentSession = Effect.fn("HostedAgentSession.require")(function* (
  userId: UserId,
  hostedAgentSessionId: HostedAgentSessionId
) {
  return yield* withUserTransaction(
    userId,
    withSubjectLock(userId, requireHostedAgentSessionInScope(userId, hostedAgentSessionId))
  ).pipe(
    Effect.tapError(() =>
      withUserTransaction(
        userId,
        withSubjectLock(userId, closeSessionInScope(userId, hostedAgentSessionId, "revoked"))
      ).pipe(Effect.orDie)
    )
  );
});

const laterOf = (base: DateTime.Utc, candidate: Option.Option<DateTime.Utc>): DateTime.Utc =>
  Option.match(candidate, { onNone: () => base, onSome: DateTime.max(base) });

/**
 * When this session last carried real work: its opening, its last terminal Turn, or a Pending Turn.
 * A Pending Turn counts as activity from when it started rather than exempting the session, because
 * admission evaluates the boundary under the Turn lock — so any Pending Turn it observes was
 * abandoned by an interrupted holder, and exempting one would let recovery, which stamps a terminal
 * time of its own, roll an arbitrarily old session forward on nothing but its own repair.
 */
const lastActivityAt = (row: HostedAgentSessionRow): DateTime.Utc =>
  laterOf(laterOf(row.startedAt, row.lastTerminalTurnAt), row.latestPendingTurnAt);

/** Decides whether the session may still carry hosted work. */
const remainsWithinIdleBoundary = (row: HostedAgentSessionRow, now: DateTime.Utc): boolean =>
  now.epochMilliseconds <
  DateTime.addDuration(lastActivityAt(row), hostedAgentSessionIdleDuration).epochMilliseconds;

const closeSessionInScope = Effect.fn("HostedAgentSession.close")(function* (
  userId: UserId,
  id: HostedAgentSessionId,
  status: "revoked" | "idle-ended"
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE hosted_agent_sessions SET status = ${status}
    WHERE user_id = ${userId} AND id = ${id} AND status = 'active'
  `;
});

/**
 * Continues the active session, or closes it and returns `None` so admission opens a fresh one
 * against current Consent. It fails only when no session may be carried at all.
 */
const continueOrCloseActiveSessionInScope = Effect.fn("HostedAgentSession.continueOrClose")(
  function* (userId: UserId, row: HostedAgentSessionRow, now: DateTime.Utc) {
    if (!(yield* sessionConsentStandsInScope(userId, row.consentGrantId))) {
      // Closing without failing is what lets admission fall through to current Consent. Failing
      // here would roll the close back, and one-active-session-per-User would then refuse every
      // later message — including after the User re-grants.
      yield* closeSessionInScope(userId, row.id, "revoked");
      return Option.none<HostedAgentSession>();
    }
    if (remainsWithinIdleBoundary(row, now)) return Option.some(fromRow(row));
    yield* closeSessionInScope(userId, row.id, "idle-ended");
    return Option.none<HostedAgentSession>();
  }
);

/** Opens a fresh session that captures the exact current onboarding Consent basis. */
const openSessionInScope = Effect.fn("HostedAgentSession.open")(function* (
  userId: UserId,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  // Revocation targets one grant, so an earlier unrevoked grant can still match current terms.
  // Admission reads the shared standing first, or it would admit hosted work on that older grant
  // while every other credential refuses on the revocation the User actually performed.
  if ((yield* onboardingConsentStandingInScope(userId)) !== "granted") {
    return yield* new HostedAgentSessionConsentRequired({ userId });
  }
  const grant = yield* currentOnboardingGrantInScope(userId);
  if (Option.isNone(grant)) return yield* new HostedAgentSessionConsentRequired({ userId });
  // Continuity is created only once a grant exists, so an unconsented or unknown User leaves no
  // persisted conversation state behind.
  yield* sql`
    INSERT INTO conversation_continuity (user_id, revision)
    VALUES (${userId}, 0)
    ON CONFLICT (user_id) DO NOTHING
  `;
  const id = yield* makeSessionId();
  const consent = grant.value;
  const basis = consent.disclosure;
  yield* sql`
    INSERT INTO hosted_agent_sessions (
      user_id, id, consent_grant_id, disclosure_revision, disclosure_sha256,
      policy_revision, policy_sha256, status, started_at
    ) VALUES (
      ${userId}, ${id}, ${consent.id}, ${basis.revision}, ${basis.contentSha256},
      ${basis.policy.revision}, ${basis.policy.contentSha256}, 'active', ${now}
    )
  `;
  return HostedAgentSession.make({
    id,
    subjectUserId: userId,
    consentBasis: {
      grantId: consent.id,
      disclosureRevision: basis.revision,
      disclosureSha256: basis.contentSha256,
      policyRevision: basis.policy.revision,
      policySha256: basis.policy.contentSha256,
    },
    startedAt: now,
    lastTerminalTurnAt: Option.none(),
    status: "active",
  });
});

const admitInScope = Effect.fn("HostedAgentSession.admitInScope")(function* (userId: UserId) {
  const now = yield* DateTime.now;
  const active = yield* activeSessionInScope(userId);
  const continued = Option.isNone(active)
    ? Option.none<HostedAgentSession>()
    : yield* continueOrCloseActiveSessionInScope(userId, active.value, now);
  if (Option.isSome(continued)) return continued.value;
  return yield* openSessionInScope(userId, now);
});

/**
 * Admits or continues the User's durable hosted session under the Consent subject lock. Current
 * terms are checked only when opening a new session; explicit revocation closes an active one.
 */
export const admitHostedAgentSession = Effect.fn("HostedAgentSession.admit")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    userId,
    withSubjectLock(
      userId,
      admitInScope(userId).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    )
  ).pipe(Effect.catchTags({ ConfigError: Effect.die, SqlError: Effect.die }));
});
