import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { DisclosureSnapshot } from "../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../src/core/identity/contract";
import { currentDisclosureFor, protectConsentStatement } from "../src/shell/consent/operations";
import type { ConsentUnavailable } from "./consent/contract";
import type { InsightUnavailable } from "./insights/contract";
import type { ReminderSchedule } from "../src/core/insights/contract";
import {
  createProactivityConsentOffer,
  readConsentStanding,
  recordConsentRevocation,
  recordProactivityConsentDisclosure,
} from "./consent/operations";
import { findReminderSchedule, recordProactivityDecision } from "./insights/operations";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";
import { newId } from "./secret-material/operations";
import { HostedAgentSessionConsentBasis, TranscriptTurnId } from "../src/core/agent/contract";
import { mintHostedStatementCaller } from "./agent/operations";
import type { WhatsAppHostedSubject } from "./whatsapp/contract";
import type { HostedCanonicalCaller } from "./canonical-work/contract";
import { whatsAppAssociationQuery } from "../src/shell/identity/operations";

/** Remove the seeded Session's active authority without fabricating delivery/terminal evidence. */
export const endTestHostedAuthority = (
  input: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE hosted_agent_sessions SET status='idle-ended' WHERE id=? AND user_id=?")
      .bind(input.caller.sessionId, input.caller.userId)
      .run()
  ).pipe(Effect.asVoid);

const testHostedConsentBasis = (
  db: D1Database
): Effect.Effect<string, ConsentUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const standing = yield* readConsentStanding({ db, userId: proactivityTestUsers[0] });
    if (standing._tag === "Missing") return yield* Effect.die("Fixture needs processing Consent");
    return yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(HostedAgentSessionConsentBasis))
    )(standing.basis);
  });

const fixtureHostedSubject = (): WhatsAppHostedSubject => ({
  _tag: "WhatsAppHosted",
  userId: proactivityTestUsers[0],
  portfolioId: proactivityTestCallers[0].businessPortfolioId,
  bsuid: proactivityTestCallers[0].businessScopedUserId,
});

/** Establish real held Turn/channel rows, then mint through Agent's live authority seam. No browser credential substitutes for the hosted caller. */
export const proactivityHostedCaller = (
  db: D1Database
): Effect.Effect<
  HostedCanonicalCaller,
  Cause.UnknownError | Schema.SchemaError | ConsentUnavailable
> =>
  Effect.gen(function* () {
    const userId = proactivityTestUsers[0];
    const caller = proactivityTestCallers[0];
    const sessionId = newId();
    const turnId = TranscriptTurnId.make(newId());
    const current = proactivityTestNow.epochMilliseconds;
    const basis = yield* testHostedConsentBasis(db);
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,?,?,'active')"
          )
          .bind(sessionId, userId, basis, current),
        db
          .prepare(
            "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,status) VALUES (?,?,?,?,'pending')"
          )
          .bind(turnId, userId, sessionId, current),
        db
          .prepare(
            "INSERT INTO hosted_whatsapp_inbound(turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms) VALUES (?,?,?,?,'held-reminder-read','123456789',?,?)"
          )
          .bind(
            turnId,
            userId,
            caller.businessPortfolioId,
            caller.businessScopedUserId,
            current,
            current
          ),
      ])
    );
    const association = whatsAppAssociationQuery({ userId, caller });
    return Option.getOrThrow(
      yield* mintHostedStatementCaller({
        db,
        subject: fixtureHostedSubject(),
        turnId,
        current,
        approval: Option.none(),
        live: protectConsentStatement({
          subject: { _tag: "User", userId },
          requirement: "active",
          statement: {
            sql: `SELECT 1 WHERE EXISTS (${association.sql})`,
            params: association.params,
          },
        }),
      })
    );
  });

/** Broad native proactivity integration fixture: real D1 schema and established identities, never substituted owner persistence. Each call acquires an independent database. */
export const proactivityTestDatabases = isolatedTestDatabases();
export const proactivityTestUsers = [
  UserId.make("10000000-0000-4000-8000-000000000051"),
  UserId.make("10000000-0000-4000-8000-000000000052"),
] as const;
const caller = (id: string): WhatsAppCallerReference =>
  Schema.decodeSync(WhatsAppCallerReference)({
    businessPortfolioId: "portfolio",
    businessScopedUserId: id,
  });
export const proactivityTestCallers = [caller("CO.abcdef"), caller("CO.ghijkl")] as const;
export const proactivityTestNow = DateTime.makeUnsafe("2026-10-05T23:00:00Z");
/** Activate through real qualified disclosure and atomic owner operations for native schedule tests. */
export const activateTestReminder = (
  db: D1Database
): Effect.Effect<ReminderSchedule, ConsentUnavailable | InsightUnavailable> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: proactivityTestUsers[0],
      caller: proactivityTestCallers[0],
      kind: "manual-entry-reminder" as const,
      now: proactivityTestNow,
    };
    const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
    yield* recordProactivityConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "reminder-disclosed",
    });
    yield* recordProactivityDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: "reminder-accepted",
    });
    return Option.getOrThrow(yield* findReminderSchedule(context));
  });

const credentialDigestBytes = 32;
const browserFreshLifetimeMs = 600000;
const browserHardLifetimeMs = 7776000000;

/** Seed an established browser proof, then append processing withdrawal through the real Consent owner; do not disable or rewrite the reminder schedule. */
export const withdrawTestProcessingConsent = (
  db: D1Database
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const pairingId = newId();
    const id = newId();
    const userId = proactivityTestUsers[0];
    const digest = crypto.getRandomValues(new Uint8Array(credentialDigestBytes));
    const current = proactivityTestNow.epochMilliseconds;
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO browser_login_pairings
        (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms)
        VALUES (?,'123456789',?,?,'consumed',?,?)`)
          .bind(pairingId, digest, userId, current, current + browserFreshLifetimeMs),
        db
          .prepare(`INSERT INTO web_sessions
        (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,?)`)
          .bind(
            id,
            pairingId,
            userId,
            digest,
            current,
            current + browserFreshLifetimeMs,
            current + browserFreshLifetimeMs,
            current + browserHardLifetimeMs
          ),
        recordConsentRevocation({
          db,
          subject: { id, userId, digest },
          evidenceId: newId(),
          current,
        }),
      ])
    );
  });

export const proactivityDatabase: Effect.Effect<
  D1Database,
  Cause.UnknownError | Schema.SchemaError
> = Effect.gen(function* () {
  const db = yield* Effect.tryPromise(() => proactivityTestDatabases.acquire());
  const names = Array.from(
    new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
  ).sort();
  yield* Effect.tryPromise(() =>
    installTestSchema({
      db,
      sources: names.map((name) => new URL(`./migrations/${name}`, import.meta.url)),
    })
  );
  const disclosure = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
  )(currentDisclosureFor());
  for (const subject of [
    { userId: proactivityTestUsers[0], caller: proactivityTestCallers[0] },
    { userId: proactivityTestUsers[1], caller: proactivityTestCallers[1] },
  ]) {
    const { userId, caller } = subject;
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(userId, proactivityTestNow.epochMilliseconds),
        db
          .prepare(
            "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
          )
          .bind(
            userId,
            caller.businessPortfolioId,
            caller.businessScopedUserId,
            proactivityTestNow.epochMilliseconds
          ),
        db
          .prepare(
            "INSERT INTO onboarding_consent_records(id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',0,0)"
          )
          .bind(userId, userId, disclosure),
      ])
    );
  }
  return db;
});
