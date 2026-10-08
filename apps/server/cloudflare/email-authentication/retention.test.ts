import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { reconcileBrowserPairingEmail, reconcileEmailReplacement } from "./runtime";

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
