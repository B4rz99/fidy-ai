import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, Effect } from "effect";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import coreWorker from "../core-worker";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { sweepExpiredConsent } from "../consent/ingress/runtime";
import {
  reconcileBrowserPairingEmail,
  reconcileEmailReplacement,
  reconcileOnboardingEmail,
} from "./runtime";

const databases = isolatedTestDatabases();
const now = 1_800_000_000_000;
const day = 86_400_000;
const id = (kind: number, index: number): string =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
afterAll(() => databases.dispose());

const setup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const directory = new URL("../migrations/", import.meta.url);
    const names = Array.from(new Bun.Glob("*.sql").scanSync(directory.pathname)).sort();
    yield* Effect.tryPromise(() =>
      installTestSchema({ db, sources: names.map((name) => new URL(name, directory)) })
    );
    return db;
  });

const seedUser = (
  db: D1Database,
  index: number
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
        .bind(id(1, index), now - day),
      db
        .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
        .bind(id(1, index), `user${index}@example.test`, now - day),
      db
        .prepare(`INSERT INTO browser_login_pairings
    (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms)
    VALUES (?, ?, zeroblob(32), ?, 'consumed', ?, ?)`)
        .bind(
          id(2, index),
          `U${String(index).padStart(3, "0")}-ABCD`,
          id(1, index),
          now - 1,
          now - 1 + 600_000
        ),
      db
        .prepare(`INSERT INTO web_sessions
    (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id(3, index),
          id(2, index),
          id(1, index),
          new TextEncoder().encode(String(index).padStart(32, "0")),
          now - 1,
          now - 1 + 600_000,
          now + 600_000,
          now - 1 + 7_776_000_000
        ),
    ])
  );

const seedPairingProof = (
  db: D1Database,
  index: number,
  { expires, user }: { expires: number; user: number } = { expires: now, user: 1 }
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(`INSERT INTO browser_login_pairings
    (id, public_code, verifier_digest, state, created_at_ms, expires_at_ms)
    VALUES (?, ?, zeroblob(32), 'pending_approval', ?, ?)`)
        .bind(id(4, index), `P${String(index).padStart(3, "0")}-ABCD`, expires - 600_000, expires),
      db
        .prepare(`INSERT INTO browser_pairing_email_proofs
    (pairing_id, work_id, user_id, email_address, credential_verified_at_ms, state,
     public_code, proof_digest, proof_expires_at_ms, expires_at_ms, generation, last_requested_at_ms)
    VALUES (?, ?, ?, ?, ?, 'awaiting_proof', ?, zeroblob(32), ?, ?, 1, ?)`)
        .bind(
          id(4, index),
          id(5, index),
          id(1, user),
          `user${user}@example.test`,
          now - day,
          `E${String(index).padStart(3, "0")}-ABCD`,
          expires,
          expires,
          expires - 600_000
        ),
      db
        .prepare("INSERT INTO browser_pairing_email_outbox (id, created_at_ms) VALUES (?, ?)")
        .bind(id(5, index), expires - 600_000),
    ])
  );

const seedReplacement = (
  db: D1Database,
  index: number,
  { expires }: { expires: number } = { expires: now }
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* seedUser(db, index);
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO email_replacements
      (user_id, work_id, session_id, candidate_email, prior_email, prior_verified_at_ms,
       state, public_code, proof_digest, proof_expires_at_ms, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'awaiting_proof', ?, zeroblob(32), ?, ?, ?)`)
          .bind(
            id(1, index),
            id(6, index),
            id(3, index),
            `candidate${index}@example.test`,
            `user${index}@example.test`,
            now - day,
            `R${String(index).padStart(3, "0")}-ABCD`,
            expires,
            expires - 600_000,
            expires
          ),
        db
          .prepare("INSERT INTO email_replacement_outbox (id, created_at_ms) VALUES (?, ?)")
          .bind(id(6, index), expires - 600_000),
      ])
    );
  });

const seedEnrollment = (
  db: D1Database,
  index: number,
  { expires }: { expires: number } = { expires: now }
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, Cause.UnknownError> => {
  const created = expires - day;
  return Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(`INSERT INTO pending_consent_exchanges
      (id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256,
       correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms,
       decision_not_before_ms, expires_at_ms, state)
      VALUES (?, 'portfolio', ?, 'phone', ?, ?, ?, '{}', 'disclosure', ?, ?, ?, ?, 'awaiting_decision')`)
        .bind(
          id(7, index),
          `CO.Person${index}`,
          `initial${index}`,
          "a".repeat(64),
          id(8, index),
          created,
          created + 1_000,
          created + 1_000,
          expires
        ),
      db
        .prepare(`INSERT INTO pending_consent_decisions
      (exchange_id, portfolio_id, bsuid, phone_number_id, decision, disclosure_json, disclosure_message_id,
       decision_message_id, delivery_key, body_sha256, occurred_at_ms, received_at_ms)
      VALUES (?, 'portfolio', ?, 'phone', 'accepted', '{}', 'disclosure', ?, ?, ?, ?, ?)`)
        .bind(
          id(7, index),
          `CO.Person${index}`,
          `decision${index}`,
          `delivery${index}`,
          "b".repeat(64),
          created + 2_000,
          created + 2_000
        ),
      db
        .prepare(`INSERT INTO pending_email_enrollments
      (id, exchange_id, email_address, submission_message_id, submission_body_sha256,
       created_at_ms, expires_at_ms, state, public_code, proof_digest, proof_expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_proof', ?, zeroblob(32), ?)`)
        .bind(
          id(9, index),
          id(7, index),
          `pending${index}@example.test`,
          `email${index}`,
          "c".repeat(64),
          created + 3_000,
          expires,
          `N${String(index).padStart(3, "0")}-ABCD`,
          expires
        ),
    ])
  );
};

it("expires pairing proofs at the exact deadline in bounded sweeps without touching another User's live proof or credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedUser(db, 1);
      yield* seedUser(db, 2);
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedPairingProof(db, index),
        { discard: true }
      );
      yield* seedPairingProof(db, 34, { expires: now + 1, user: 2 });
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO browser_pairing_email_outbox (id, created_at_ms) VALUES (?, ?)")
          .bind(id(5, 35), now)
          .run()
      );
      const live = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT * FROM browser_pairing_email_proofs WHERE user_id = ?")
          .bind(id(1, 2))
          .all()
      );
      const credentials = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id").all()
      );

      yield* reconcileBrowserPairingEmail(db);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM browser_pairing_email_proofs WHERE expires_at_ms <= ?"
            )
            .bind(now)
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM browser_pairing_email_outbox").first()
        )
      ).toEqual({ count: 3 });
      yield* reconcileBrowserPairingEmail(db);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM browser_pairing_email_proofs").all()
        )).results
      ).toEqual(live.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM browser_pairing_email_outbox").all()
        )).results
      ).toEqual([{ id: id(5, 34) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id").all()
        )).results
      ).toEqual(credentials.results);
    })
  ));

it("expires replacement candidates and orphaned outboxes in bounded sweeps while preserving the current credentials and another User's live candidate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedReplacement(db, index),
        { discard: true }
      );
      yield* seedReplacement(db, 34, { expires: now + 1 });
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO email_replacement_outbox (id, created_at_ms) VALUES (?, ?)")
          .bind(id(6, 35), now)
          .run()
      );
      const live = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM email_replacements WHERE user_id = ?").bind(id(1, 34)).all()
      );
      const credentials = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id").all()
      );

      yield* reconcileEmailReplacement(db);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM email_replacements WHERE expires_at_ms <= ?")
            .bind(now)
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM email_replacement_outbox").first()
        )
      ).toEqual({ count: 3 });
      yield* reconcileEmailReplacement(db);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM email_replacements").all()))
          .results
      ).toEqual(live.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM email_replacement_outbox").all()
        )).results
      ).toEqual([{ id: id(6, 34) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id").all()
        )).results
      ).toEqual(credentials.results);
    })
  ));

it("cascades expired onboarding proof and outbox deletion in bounded Consent sweeps without creating a User or deleting a live enrollment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.forEach(
        Array.from({ length: 129 }, (_, index) => index + 1),
        (index) => seedEnrollment(db, index),
        { discard: true }
      );
      yield* seedEnrollment(db, 130, { expires: now + 1 });
      const live = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM pending_email_enrollments WHERE id = ?").bind(id(9, 130)).all()
      );

      yield* sweepExpiredConsent(db)();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM pending_email_enrollments").first()
        )
      ).toEqual({ count: 2 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM onboarding_email_outbox").first()
        )
      ).toEqual({ count: 2 });
      yield* sweepExpiredConsent(db)();
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_email_enrollments").all()
        )).results
      ).toEqual(live.results);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([{ id: id(9, 130) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([{ id: id(7, 130) }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  ));

it("runs every email retention activity even when an unrelated scheduled Queue publication fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedUser(db, 1);
      yield* seedReplacement(db, 2);
      yield* seedReplacement(db, 3, { expires: now + 1 });
      yield* seedPairingProof(db, 1);
      yield* seedPairingProof(db, 2, { expires: now + 1, user: 3 });
      yield* seedEnrollment(db, 1);
      yield* seedEnrollment(db, 2, { expires: now + 1 });
      // Pending delivery is live so the scheduler actually attempts the failing publication.
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_email_enrollments SET state = 'awaiting_delivery', public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL WHERE id = ?"
          )
          .bind(id(9, 2))
          .run()
      );
      const send = vi.fn(() => Promise.reject(new Error("queue unavailable")));
      yield* Effect.tryPromise(() =>
        expect(
          coreWorker.scheduled(
            { cron: "* * * * *", scheduledTime: now, noRetry: () => undefined },
            {
              DB: db,
              AI: { run: () => Promise.reject(new Error("unused inference")) },
              USER_TRANSACTION_COORDINATOR: {
                getByName: (): Pick<Fetcher, "fetch"> => ({
                  fetch: () => Promise.reject(new Error("unused coordinator")),
                }),
              },
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              CLOUDFLARE_ACCESS_AUDIENCE: "",
              CLOUDFLARE_ACCESS_ISSUER: "",
              CONTRACT_DIGEST: "a".repeat(64),
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              KAPSO_API_KEY: "",
              KAPSO_WEBHOOK_SECRET: "",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              WOMPI_ENVIRONMENT: "",
              WOMPI_INTEGRITY_SECRET: "",
              WOMPI_PRIVATE_KEY: "",
              WOMPI_PUBLIC_KEY: "",
              ONBOARDING_EMAIL_QUEUE: {
                send,
                sendBatch: () => Promise.reject(new Error("unused batch")),
                metrics: () => Promise.reject(new Error("unused metrics")),
              },
            }
          )
        ).rejects.toThrow()
      );
      expect(send).toHaveBeenCalledOnce();
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT pairing_id FROM browser_pairing_email_proofs").all()
        )).results
      ).toEqual([{ pairing_id: id(4, 2) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM browser_pairing_email_outbox").all()
        )).results
      ).toEqual([{ id: id(5, 2) }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM email_replacements").all()))
          .results
      ).toEqual([{ user_id: id(1, 3) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM email_replacement_outbox").all()
        )).results
      ).toEqual([{ id: id(6, 3) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM pending_email_enrollments").all()
        )).results
      ).toEqual([{ id: id(9, 2) }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([{ id: id(9, 2) }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT user_id, email_address FROM verified_email_credentials ORDER BY user_id"
            )
            .all()
        )).results
      ).toEqual([
        { user_id: id(1, 1), email_address: "user1@example.test" },
        { user_id: id(1, 2), email_address: "user2@example.test" },
        { user_id: id(1, 3), email_address: "user3@example.test" },
      ]);
    })
  ));

it("abandons interrupted pairing sends without retaining reusable proof or changing another User's live send", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedUser(db, 1);
      yield* seedUser(db, 2);
      // Leave one expired send observable after the owner's bounded deletion.
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedPairingProof(db, index, { expires: now - 600_001, user: 1 }),
        { discard: true }
      );
      yield* seedPairingProof(db, 34, { expires: now + 600_000, user: 2 });
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE browser_pairing_email_proofs SET state = 'sending'").run()
      );
      const live = db
        .prepare("SELECT * FROM browser_pairing_email_proofs WHERE user_id = ?")
        .bind(id(1, 2));
      const outbox = db
        .prepare("SELECT * FROM browser_pairing_email_outbox WHERE id = ?")
        .bind(id(5, 34));
      const pairings = db.prepare("SELECT * FROM browser_login_pairings ORDER BY id");
      const sessions = db.prepare("SELECT * FROM web_sessions ORDER BY id");
      const beforeLive = yield* Effect.tryPromise(() => live.first());
      const beforeOutbox = yield* Effect.tryPromise(() => outbox.first());
      const beforePairings = yield* Effect.tryPromise(() => pairings.all());
      const beforeSessions = yield* Effect.tryPromise(() => sessions.all());

      yield* reconcileBrowserPairingEmail(db);

      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT state, public_code, proof_digest, proof_expires_at_ms
              FROM browser_pairing_email_proofs WHERE user_id = ?`)
            .bind(id(1, 1))
            .all()
        )).results
      ).toEqual([
        { state: "ambiguous", public_code: null, proof_digest: null, proof_expires_at_ms: null },
      ]);
      expect(yield* Effect.tryPromise(() => live.first())).toEqual(beforeLive);
      expect(yield* Effect.tryPromise(() => outbox.first())).toEqual(beforeOutbox);
      expect((yield* Effect.tryPromise(() => pairings.all())).results).toEqual(
        beforePairings.results
      );
      expect((yield* Effect.tryPromise(() => sessions.all())).results).toEqual(
        beforeSessions.results
      );
    })
  ));

it("abandons interrupted replacement sends without reusable proof, credential replacement or session changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      // One candidate per User requires distinct Users for the expired backlog.
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedReplacement(db, index, { expires: now - 600_001 }),
        { discard: true }
      );
      yield* seedReplacement(db, 34, { expires: now + 600_000 });
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE email_replacements SET state = 'sending'").run()
      );
      const live = db.prepare("SELECT * FROM email_replacements WHERE user_id = ?").bind(id(1, 34));
      const outbox = db
        .prepare("SELECT * FROM email_replacement_outbox WHERE id = ?")
        .bind(id(6, 34));
      const credentials = db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id");
      const sessions = db.prepare("SELECT * FROM web_sessions ORDER BY id");
      const beforeLive = yield* Effect.tryPromise(() => live.first());
      const beforeOutbox = yield* Effect.tryPromise(() => outbox.first());
      const beforeCredentials = yield* Effect.tryPromise(() => credentials.all());
      const beforeSessions = yield* Effect.tryPromise(() => sessions.all());

      yield* reconcileEmailReplacement(db);

      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT state, public_code, proof_digest, proof_expires_at_ms
              FROM email_replacements WHERE user_id <> ?`)
            .bind(id(1, 34))
            .all()
        )).results
      ).toEqual([
        { state: "ambiguous", public_code: null, proof_digest: null, proof_expires_at_ms: null },
      ]);
      expect(yield* Effect.tryPromise(() => live.first())).toEqual(beforeLive);
      expect(yield* Effect.tryPromise(() => outbox.first())).toEqual(beforeOutbox);
      expect((yield* Effect.tryPromise(() => credentials.all())).results).toEqual(
        beforeCredentials.results
      );
      expect((yield* Effect.tryPromise(() => sessions.all())).results).toEqual(
        beforeSessions.results
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM email_replacement_audit").first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("marks only sufficiently overdue onboarding sends ambiguous without deleting enrollment or creating a User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.forEach([1, 2, 3], (index) =>
        seedEnrollment(db, index, { expires: now + 1_200_000 })
      );
      yield* seedEnrollment(db, 4);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(`UPDATE pending_email_enrollments SET state = 'sending',
              proof_expires_at_ms = ? WHERE id = ?`)
            .bind(now - 600_001, id(9, 1)),
          db
            .prepare(`UPDATE pending_email_enrollments SET state = 'sending',
              proof_expires_at_ms = ? WHERE id = ?`)
            .bind(now - 600_000, id(9, 2)),
          db
            .prepare("UPDATE pending_email_enrollments SET proof_expires_at_ms = ? WHERE id = ?")
            .bind(now - 600_001, id(9, 3)),
          db
            .prepare(`UPDATE pending_email_enrollments SET state = 'awaiting_delivery',
              public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL WHERE id = ?`)
            .bind(id(9, 4)),
        ])
      );
      const states = db.prepare("SELECT state FROM pending_email_enrollments ORDER BY id");
      const material = db.prepare(`SELECT id, exchange_id, email_address, public_code,
        proof_digest, proof_expires_at_ms, expires_at_ms FROM pending_email_enrollments ORDER BY id`);
      const outbox = db.prepare("SELECT * FROM onboarding_email_outbox ORDER BY id");
      const decisions = db.prepare("SELECT * FROM pending_consent_decisions ORDER BY exchange_id");
      const beforeMaterial = yield* Effect.tryPromise(() => material.all());
      const beforeOutbox = yield* Effect.tryPromise(() => outbox.all());
      const beforeDecisions = yield* Effect.tryPromise(() => decisions.all());

      yield* reconcileOnboardingEmail(db);

      expect((yield* Effect.tryPromise(() => states.all())).results).toEqual([
        { state: "ambiguous" },
        { state: "sending" },
        { state: "awaiting_proof" },
        { state: "awaiting_delivery" },
      ]);

      vi.setSystemTime(now + 1);
      yield* reconcileOnboardingEmail(db);

      expect((yield* Effect.tryPromise(() => states.all())).results).toEqual([
        { state: "ambiguous" },
        { state: "ambiguous" },
        { state: "awaiting_proof" },
        { state: "awaiting_delivery" },
      ]);
      expect((yield* Effect.tryPromise(() => material.all())).results).toEqual(
        beforeMaterial.results
      );
      expect((yield* Effect.tryPromise(() => outbox.all())).results).toEqual(beforeOutbox.results);
      expect((yield* Effect.tryPromise(() => decisions.all())).results).toEqual(
        beforeDecisions.results
      );
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT count(*) AS count FROM users").first())
      ).toEqual({ count: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM verified_email_credentials").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM completed_email_enrollments").first()
        )
      ).toEqual({ count: 0 });
    })
  ));
