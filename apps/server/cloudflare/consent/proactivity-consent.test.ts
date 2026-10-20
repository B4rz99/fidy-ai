import assert from "node:assert/strict";
import { afterAll, expect, it } from "vitest";
import { DateTime, Effect, Option } from "effect";
import { proactivityDisclosureFor } from "../../src/shell/consent/operations";
import {
  activateTestReminder,
  proactivityTestCallers as callers,
  proactivityTestDatabases as databases,
  proactivityTestNow as now,
  proactivityDatabase as setup,
  proactivityTestUsers as users,
} from "../proactivity.test-fixture";
import {
  createProactivityConsentOffer,
  findProactivityConsentGrant,
  prepareProactivityConsentAction,
  prepareProactivityConsentDecision,
  recordProactivityConsentDisclosure,
  sweepProactivityConsentOffers,
} from "./operations";

afterAll(() => databases.dispose());

it("expires an undecided contextual offer without losing its frozen delivery identity or blocking unrelated retention", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const schedule = yield* activateTestReminder(db);
      const occurrence = { id: "90000000-0000-4000-8000-000000000001" };
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES (?,?,'manual-entry-reminder',?,1,'CO','es-CO','America/Bogota','2026-10-06T23:00:00Z','[]')"
            )
            .bind(occurrence.id, users[0], schedule.id),
          db
            .prepare(
              "INSERT INTO insight_reports(kind,delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT 'proactivity-delivery',?,user_id,'manual-entry-reminder',consent_grant_id,'Reminder',?,?,'America/Bogota',? FROM schedules WHERE kind='reminder' AND user_id=?"
            )
            .bind(
              occurrence.id,
              now.epochMilliseconds,
              now.epochMilliseconds + 86400000,
              now.epochMilliseconds,
              users[0]
            ),
          db
            .prepare(
              "INSERT INTO proactivity_message_events(user_id,delivery_id,insight_event_id) VALUES (?,?,?)"
            )
            .bind(users[0], occurrence.id, occurrence.id),
          db
            .prepare(
              "UPDATE insight_reports SET dispatch_created_at_ms=incoming.created_at_ms,dispatch_state=incoming.state,dispatch_last_attempt_at_ms=incoming.last_attempt_at_ms,dispatch_restart_attempts=incoming.restart_attempts FROM (SELECT source.*, 0 AS restart_attempts FROM (SELECT source.*, 0 AS last_attempt_at_ms FROM (SELECT source.*, 'ready' AS state FROM (SELECT 'proactivity-delivery' AS kind,? AS user_id,? AS delivery_id,? AS created_at_ms) AS source) AS source) AS source) AS incoming WHERE insight_reports.user_id=incoming.user_id AND insight_reports.kind=incoming.kind AND insight_reports.delivery_id=incoming.delivery_id AND insight_reports.dispatch_state IS NULL"
            )
            .bind(users[0], occurrence.id, now.epochMilliseconds),
        ])
      );
      const offer = Option.getOrThrow(
        yield* createProactivityConsentOffer({
          db,
          userId: users[0],
          caller: callers[0],
          kind: "manual-entry-reminder",
          now,
        })
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO insight_reports(kind,delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES('proactivity-delivery',?,?,'reminder-offer',?,?,?,?,?,?)"
            )
            .bind(
              offer.id,
              users[0],
              offer.id,
              offer.disclosure.text,
              now.epochMilliseconds,
              offer.expiresAt.epochMilliseconds,
              "America/Bogota",
              now.epochMilliseconds
            ),
          db
            .prepare(
              "UPDATE insight_reports SET dispatch_created_at_ms=incoming.created_at_ms,dispatch_state=incoming.state,dispatch_last_attempt_at_ms=incoming.last_attempt_at_ms,dispatch_restart_attempts=incoming.restart_attempts FROM (SELECT source.*, 0 AS restart_attempts FROM (SELECT source.*, 0 AS last_attempt_at_ms FROM (SELECT source.*, 'ready' AS state FROM (SELECT 'proactivity-delivery' AS kind,? AS user_id,? AS delivery_id,? AS created_at_ms) AS source) AS source) AS source) AS incoming WHERE insight_reports.user_id=incoming.user_id AND insight_reports.kind=incoming.kind AND insight_reports.delivery_id=incoming.delivery_id AND insight_reports.dispatch_state IS NULL"
            )
            .bind(users[0], offer.id, now.epochMilliseconds),
        ])
      );
      const other = Option.getOrThrow(
        yield* createProactivityConsentOffer({
          db,
          userId: users[1],
          caller: callers[1],
          kind: "budget-threshold",
          now,
        })
      );
      yield* sweepProactivityConsentOffers({
        db,
        nowEpochMs: DateTime.makeUnsafe("2026-10-07T23:00:00Z").epochMilliseconds,
      });
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS n FROM (SELECT rowid,* FROM consent_offers WHERE kind<>'weekly-summary') AS proactivity_consent_offers WHERE id IN (?,?)"
            )
            .bind(offer.id, other.id)
            .first()
        )
      ).toEqual({ n: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT offer_id,text FROM insight_reports WHERE kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL AND user_id=? AND delivery_id=?"
            )
            .bind(users[0], offer.id)
            .first()
        )
      ).toEqual({ offer_id: offer.id, text: offer.disclosure.text });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT insight_event_id FROM proactivity_message_events WHERE user_id=? AND delivery_id=?"
            )
            .bind(users[0], occurrence.id)
            .first()
        )
      ).toEqual({ insight_event_id: occurrence.id });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=? AND delivery_id=?"
            )
            .bind(users[0], occurrence.id)
            .first()
        )
      ).toEqual({ state: "ready" });
    })
  ));

it("keeps Budget and reminder grants independent and refuses undisclosed, foreign and replayed choices without authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const input = {
        db,
        userId: users[0],
        caller: callers[0],
        kind: "budget-threshold" as const,
        now,
      };
      const offer = yield* createProactivityConsentOffer(input);
      expect(Option.isSome(offer)).toBe(true);
      if (Option.isNone(offer)) return;
      expect(
        Option.isNone(
          yield* prepareProactivityConsentDecision({
            ...input,
            choice: offer.value.acceptChoice,
            decisionMessageId: "undisclosed",
          })
        )
      ).toBe(true);
      expect(
        yield* recordProactivityConsentDisclosure({
          ...input,
          offerId: offer.value.id,
          disclosureMessageId: "budget-disclosure",
        })
      ).toBe(true);
      expect(
        Option.isNone(
          yield* prepareProactivityConsentDecision({
            ...input,
            userId: users[1],
            caller: callers[1],
            choice: offer.value.acceptChoice,
            decisionMessageId: "foreign",
          })
        )
      ).toBe(true);
      expect(
        Option.isNone(yield* findProactivityConsentGrant({ ...input, userId: users[1] }))
      ).toBe(true);
      const decision = yield* prepareProactivityConsentDecision({
        ...input,
        choice: offer.value.acceptChoice,
        decisionMessageId: "budget-accept",
      });
      expect(Option.isSome(decision)).toBe(true);
      if (Option.isNone(decision)) return;
      yield* Effect.tryPromise(() => db.batch([...decision.value.statements]));
      expect(Option.isSome(yield* findProactivityConsentGrant(input))).toBe(true);
      expect(
        Option.isNone(
          yield* findProactivityConsentGrant({ ...input, kind: "manual-entry-reminder" })
        )
      ).toBe(true);
      expect(
        Option.isNone(
          yield* prepareProactivityConsentDecision({
            ...input,
            choice: offer.value.acceptChoice,
            decisionMessageId: "budget-accept",
          })
        )
      ).toBe(true);
    })
  ));

it("prepares a grant-free decline without publishing a fictitious grant identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const input = {
        db,
        userId: users[0],
        caller: callers[0],
        kind: "budget-threshold" as const,
        now,
      };
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: offer.id,
        disclosureMessageId: "decline-disclosure",
      });
      const prepared = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: offer.declineChoice,
          decisionMessageId: "decline-no-grant",
        })
      );
      expect(prepared.decision).toBe("decline");
      expect("grantId" in prepared).toBe(false);
      yield* Effect.tryPromise(() => db.batch([...prepared.statements]));
      expect(Option.isNone(yield* findProactivityConsentGrant(input))).toBe(true);
    })
  ));

it("revokes only the selected category and fences already-prepared send actions without rewriting grant evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const base = { db, userId: users[0], caller: callers[0], now };
      const budget = Option.getOrThrow(
        yield* createProactivityConsentOffer({ ...base, kind: "budget-threshold" })
      );
      const reminder = Option.getOrThrow(
        yield* createProactivityConsentOffer({ ...base, kind: "manual-entry-reminder" })
      );
      for (const [kind, offer] of [
        ["budget-threshold", budget],
        ["manual-entry-reminder", reminder],
      ] as const) {
        const context = { ...base, kind };
        yield* recordProactivityConsentDisclosure({
          ...context,
          offerId: offer.id,
          disclosureMessageId: `${kind}-disclosed`,
        });
        const prepared = Option.getOrThrow(
          yield* prepareProactivityConsentDecision({
            ...context,
            choice: offer.acceptChoice,
            decisionMessageId: `${kind}-accepted`,
          })
        );
        yield* Effect.tryPromise(() => db.batch([...prepared.statements]));
      }
      const grant = Option.getOrThrow(
        yield* findProactivityConsentGrant({ ...base, kind: "budget-threshold" })
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE consent_action_probe(user_id TEXT PRIMARY KEY, claimed INTEGER NOT NULL)"
          )
          .run()
      );
      const action = prepareProactivityConsentAction({
        db,
        userId: users[0],
        kind: "budget-threshold",
        grantId: grant.id,
        statement: {
          sql: "INSERT INTO consent_action_probe(user_id,claimed) SELECT ?,1 WHERE 1=1",
          params: [users[0]],
        },
      });
      const context = {
        ...base,
        kind: "budget-threshold" as const,
        now: DateTime.makeUnsafe("2026-10-06T23:00:00Z"),
      };
      const revoke = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...context,
          choice: budget.revokeChoice,
          decisionMessageId: "budget-revoked",
        })
      );
      yield* Effect.tryPromise(() => db.batch([...revoke.statements, action]));
      expect(Option.isNone(yield* findProactivityConsentGrant(context))).toBe(true);
      expect(
        Option.isSome(
          yield* findProactivityConsentGrant({ ...base, kind: "manual-entry-reminder" })
        )
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT * FROM consent_action_probe")
            .all()
            .then((result) => result.results)
        )
      ).toEqual([]);
      expect(
        Option.isNone(
          yield* prepareProactivityConsentDecision({
            ...context,
            choice: budget.revokeChoice,
            decisionMessageId: "budget-revoked",
          })
        )
      ).toBe(true);
      const overwrite = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare(
              "UPDATE consent_history SET record_json='{}' WHERE record_type='proactivity_grant' AND id=?"
            )
            .bind(grant.id)
            .run()
        )
      );
      expect(overwrite._tag).toBe("Failure");
    })
  ));

it("allows only one concurrent prepared decision to commit its immutable legal evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const input = {
        db,
        userId: users[0],
        caller: callers[0],
        kind: "manual-entry-reminder" as const,
        now,
      };
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: offer.id,
        disclosureMessageId: "disclosed",
      });
      const first = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: offer.acceptChoice,
          decisionMessageId: "first",
        })
      );
      const second = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: offer.acceptChoice,
          decisionMessageId: "second",
        })
      );
      yield* Effect.tryPromise(() => db.batch([...first.statements]));
      expect(
        (yield* Effect.exit(Effect.tryPromise(() => db.batch([...second.statements]))))._tag
      ).toBe("Failure");
      const grant = Option.getOrThrow(yield* findProactivityConsentGrant(input));
      assert(first.decision === "accept");
      expect(grant.id).toBe(first.grantId);
      expect(grant.evidence._tag).toBe("ProviderQualifiedMessages");
    })
  ));

it("rejects a prepared continuation after its exact grant was revoked, leaving the new offer undecided", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const input = {
        db,
        userId: users[0],
        caller: callers[0],
        kind: "manual-entry-reminder" as const,
        now,
      };
      const firstOffer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: firstOffer.id,
        disclosureMessageId: "first-disclosure",
      });
      const accept = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: firstOffer.acceptChoice,
          decisionMessageId: "first-accept",
        })
      );
      yield* Effect.tryPromise(() => db.batch([...accept.statements]));
      const nextOffer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: nextOffer.id,
        disclosureMessageId: "next-disclosure",
      });
      const continuation = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: nextOffer.acceptChoice,
          decisionMessageId: "continue",
        })
      );
      expect(continuation.decision).toBe("continue");
      const revoke = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: firstOffer.revokeChoice,
          decisionMessageId: "revoke",
        })
      );
      yield* Effect.tryPromise(() => db.batch([...revoke.statements]));
      expect(
        (yield* Effect.exit(Effect.tryPromise(() => db.batch([...continuation.statements]))))._tag
      ).toBe("Failure");
      expect(Option.isNone(yield* findProactivityConsentGrant(input))).toBe(true);
      const renewed = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: nextOffer.acceptChoice,
          decisionMessageId: "renew",
        })
      );
      expect(renewed.decision).toBe("accept");
    })
  ));

it("deletes expired undecided disclosure offers independently while retaining accepted legal evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const input = {
        db,
        userId: users[0],
        caller: callers[0],
        kind: "budget-threshold" as const,
        now,
      };
      const acceptedOffer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: acceptedOffer.id,
        disclosureMessageId: "kept-disclosure",
      });
      const accept = Option.getOrThrow(
        yield* prepareProactivityConsentDecision({
          ...input,
          choice: acceptedOffer.acceptChoice,
          decisionMessageId: "kept-accept",
        })
      );
      yield* Effect.tryPromise(() => db.batch([...accept.statements]));
      const unused = Option.getOrThrow(
        yield* createProactivityConsentOffer({ ...input, kind: "manual-entry-reminder" })
      );
      yield* sweepProactivityConsentOffers({
        db,
        nowEpochMs: DateTime.makeUnsafe("2026-10-07T23:00:00Z").epochMilliseconds,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT rowid,* FROM consent_offers WHERE kind<>'weekly-summary') AS proactivity_consent_offers WHERE id=?"
            )
            .bind(unused.id)
            .first()
        )
      ).toBe(null);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT rowid,* FROM consent_offers WHERE kind<>'weekly-summary') AS proactivity_consent_offers WHERE id=?"
            )
            .bind(acceptedOffer.id)
            .first()
        )
      ).toEqual({ id: acceptedOffer.id });
      expect(Option.isSome(yield* findProactivityConsentGrant(input))).toBe(true);
    })
  ));

it("retains exact category disclosure hashes rather than a model-generated opt-in", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const kind of ["budget-threshold", "manual-entry-reminder"] as const) {
        const disclosure = proactivityDisclosureFor(kind);
        const bytes = yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(disclosure.text))
        );
        const hash = new Uint8Array(bytes);
        expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
          disclosure.contentSha256
        );
      }
    })
  ));
