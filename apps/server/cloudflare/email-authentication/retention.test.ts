import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, Effect, Option } from "effect";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  dispatchBrowserPairingEmail,
  dispatchEmailReplacement,
  reconcileBrowserPairingEmail,
  reconcileEmailReplacement,
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
  index: number,
  legacy = false
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
        )
        .bind(id(1, index), now - day),
      db
        .prepare(
          legacy
            ? "INSERT INTO verified_email_credentials(user_id,email_address,verified_at_ms) VALUES (?,?,?)"
            : "WITH incoming(user_id,email_address,verified_at_ms) AS (VALUES (?, ?, ?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,verified_email_address,email_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.email_address,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET verified_email_address=excluded.verified_email_address,email_verified_at_ms=excluded.email_verified_at_ms"
        )
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
        .prepare(
          `UPDATE browser_login_pairings SET email_work_id=incoming.work_id,email_user_id=incoming.user_id,email_address=incoming.email_address,email_credential_verified_at_ms=incoming.credential_verified_at_ms,email_state=incoming.state,email_public_code=incoming.public_code,email_proof_digest=incoming.proof_digest,email_proof_expires_at_ms=incoming.proof_expires_at_ms,email_expires_at_ms=incoming.expires_at_ms,email_generation=incoming.generation,email_last_requested_at_ms=incoming.last_requested_at_ms,email_wrong_attempts=incoming.wrong_attempts FROM (SELECT source.*, 0 AS wrong_attempts FROM (SELECT ? AS pairing_id,? AS work_id,? AS user_id,? AS email_address,? AS credential_verified_at_ms,'awaiting_proof' AS state,? AS public_code,zeroblob(32) AS proof_digest,? AS proof_expires_at_ms,? AS expires_at_ms,1 AS generation,? AS last_requested_at_ms) AS source) AS incoming WHERE browser_login_pairings.id=incoming.pairing_id AND browser_login_pairings.email_work_id IS NULL`
        )
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
    ])
  );

const seedReplacement = (
  db: D1Database,
  index: number,
  { expires, legacy }: { expires: number; legacy: boolean } = { expires: now, legacy: false }
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* seedUser(db, index, legacy);
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
      const live = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT * FROM (SELECT id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE user_id = ?"
          )
          .bind(id(1, 2))
          .all()
      );
      const credentials = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT * FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) ORDER BY user_id"
          )
          .all()
      );

      yield* reconcileBrowserPairingEmail(db);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE expires_at_ms <= ?"
            )
            .bind(now)
            .first()
        )
      ).toEqual({ count: 1 });

      yield* reconcileBrowserPairingEmail(db);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs"
            )
            .all()
        )).results
      ).toEqual(live.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) ORDER BY user_id"
            )
            .all()
        )).results
      ).toEqual(credentials.results);
    })
  ));

it("expires replacement candidates in bounded sweeps while preserving the current credentials and another User's live candidate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedReplacement(db, index),
        { discard: true }
      );
      yield* seedReplacement(db, 34, { expires: now + 1, legacy: false });
      const live = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM email_replacements WHERE user_id = ?").bind(id(1, 34)).all()
      );
      const credentials = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT * FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) ORDER BY user_id"
          )
          .all()
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

      yield* reconcileEmailReplacement(db);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM email_replacements").all()))
          .results
      ).toEqual(live.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) ORDER BY user_id"
            )
            .all()
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
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedPairingProof(db, index, { expires: now - 600_001, user: 1 }),
        { discard: true }
      );
      yield* seedPairingProof(db, 34, { expires: now + 600_000, user: 2 });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_state = 'sending' WHERE email_work_id IS NOT NULL "
          )
          .run()
      );
      const live = db
        .prepare(
          "SELECT * FROM (SELECT id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE user_id = ?"
        )
        .bind(id(1, 2));
      const pairings = db.prepare(
        "SELECT id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms,wrong_attempts,last_poll_at_ms,minimum_poll_interval_seconds FROM browser_login_pairings ORDER BY id"
      );
      const sessions = db.prepare("SELECT * FROM web_sessions ORDER BY id");
      const beforeLive = yield* Effect.tryPromise(() => live.first());
      const beforePairings = yield* Effect.tryPromise(() => pairings.all());
      const beforeSessions = yield* Effect.tryPromise(() => sessions.all());

      yield* reconcileBrowserPairingEmail(db);

      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT state, public_code, proof_digest, proof_expires_at_ms
              FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE user_id = ?`)
            .bind(id(1, 1))
            .all()
        )).results
      ).toEqual([
        { state: "ambiguous", public_code: null, proof_digest: null, proof_expires_at_ms: null },
      ]);
      expect(yield* Effect.tryPromise(() => live.first())).toEqual(beforeLive);
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
      yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index + 1),
        (index) => seedReplacement(db, index, { expires: now - 600_001, legacy: false }),
        { discard: true }
      );
      yield* seedReplacement(db, 34, { expires: now + 600_000, legacy: false });
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE email_replacements SET state = 'sending'").run()
      );
      const live = db.prepare("SELECT * FROM email_replacements WHERE user_id = ?").bind(id(1, 34));
      const credentials = db.prepare(
        "SELECT * FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) ORDER BY user_id"
      );
      const sessions = db.prepare("SELECT * FROM web_sessions ORDER BY id");
      const beforeLive = yield* Effect.tryPromise(() => live.first());
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
      expect((yield* Effect.tryPromise(() => credentials.all())).results).toEqual(
        beforeCredentials.results
      );
      expect((yield* Effect.tryPromise(() => sessions.all())).results).toEqual(
        beforeSessions.results
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'emailAuthentication.*'"
            )
            .first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("keeps email dispatch cooldowns through migration and retries only the current proof identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = [...new Bun.Glob("*.sql").scanSync(directory.pathname)]
        .filter((name) => name < "0125_")
        .sort();
      for (const name of names) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      yield* seedUser(db, 1, true);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,state,created_at_ms,expires_at_ms) VALUES (?, 'P001-ABCD',zeroblob(32),'pending_approval',?,?)"
            )
            .bind(id(4, 1), now, now + 600_000),
          db
            .prepare(
              "INSERT INTO browser_pairing_email_proofs(pairing_id,work_id,user_id,email_address,credential_verified_at_ms,state,expires_at_ms,generation,wrong_attempts,last_requested_at_ms) VALUES (?,?,?,'user1@example.test',?,'awaiting_delivery',?,1,0,?)"
            )
            .bind(id(4, 1), id(5, 1), id(1, 1), now - day, now + 600_000, now),
        ])
      );
      yield* seedReplacement(db, 2, { expires: now + 600_000, legacy: true });
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "UPDATE email_replacements SET state='awaiting_delivery',public_code=NULL,proof_digest=NULL,proof_expires_at_ms=NULL"
          ),
          db
            .prepare(
              "INSERT INTO browser_pairing_email_outbox(id,created_at_ms,last_attempt_at_ms) VALUES(?,?,?)"
            )
            .bind(id(5, 1), now, now),
          db
            .prepare(
              "INSERT INTO email_replacement_outbox(id,created_at_ms,last_attempt_at_ms) VALUES(?,?,?)"
            )
            .bind(id(6, 2), now, now),
          // Superseded work must not become another dispatchable identity.
          db
            .prepare("INSERT INTO email_replacement_outbox(id,created_at_ms) VALUES(?,?)")
            .bind(id(6, 3), now),
        ])
      );
      for (const name of [
        "0125_browser_pairing_dispatch.sql",
        "0126_email_replacement_dispatch.sql",
      ]) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
        );
      }
      // Continue through the current schema before invoking current dispatch behavior.
      for (const name of [...new Bun.Glob("*.sql").scanSync(directory.pathname)]
        .filter((name) => name > "0126_email_replacement_dispatch.sql")
        .sort()) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      const offered: string[] = [];
      const dispatch = (): Effect.Effect<ReadonlyArray<void>, void> =>
        Effect.all([
          dispatchBrowserPairingEmail({
            DB: db,
            identity: Option.none(),
            BROWSER_PAIRING_EMAIL_QUEUE: {
              send: (work) => {
                offered.push(work.id);
                return Promise.resolve();
              },
            },
          }),
          dispatchEmailReplacement({
            DB: db,
            identity: Option.none(),
            EMAIL_REPLACEMENT_QUEUE: {
              send: (work) => {
                offered.push(work.id);
                return Promise.resolve();
              },
            },
          }),
        ]);
      yield* dispatch();
      expect(offered).toEqual([]);
      vi.setSystemTime(now + 60_001);
      yield* dispatch();
      expect(offered.sort()).toEqual([id(5, 1), id(6, 2)]);
      yield* dispatch();
      expect(offered).toHaveLength(2);
    })
  ));
