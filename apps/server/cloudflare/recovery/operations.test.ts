import { NodeFileSystem } from "@effect/platform-node";
import { Miniflare } from "miniflare";
import { afterEach } from "vitest";
import { expect, it } from "@effect/vitest";
import { UserId } from "../../src/core/identity/reference";
import { BackupRecoveryCode } from "../../src/core/recovery/contract";
import { Effect, FileSystem, Option, Schema } from "effect";
import { prepareInitialBackupRecoveryCode } from "./operations";

const instances: Array<Miniflare> = [];
afterEach(() =>
  Effect.runPromise(
    Effect.all(instances.splice(0).map((instance) => Effect.promise(() => instance.dispose())))
  )
);
const setup = Effect.gen(function* () {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "recovery",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "recovery", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok') } }",
              },
            },
          },
        },
      },
    ],
  });
  instances.push(instance);
  yield* Effect.tryPromise(() => instance.ready);
  const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
  const files = yield* FileSystem.FileSystem;
  for (const name of [
    "0003_pending_consent",
    "0004_onboarding_email",
    "0005_verified_onboarding",
    "0006_browser_login",
    "0007_browser_pairing_email",
    "0008_support_recovery",
  ]) {
    const sql = yield* files.readFileString(
      new URL(`../migrations/${name}.sql`, import.meta.url).pathname
    );
    for (const statement of sql
      .replace(/^--.*$/gmu, "")
      .trim()
      .split(/;\s*\n(?=CREATE |ALTER |$)/u)) {
      yield* Effect.tryPromise(() => db.prepare(statement).run());
    }
  }
  return db;
}).pipe(Effect.provide(NodeFileSystem.layer));
const alice = UserId.make("10000000-0000-4000-8000-000000000001");
const bob = UserId.make("10000000-0000-4000-8000-000000000002");
const insertUser = (db: D1Database, userId: UserId): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)"
    )
    .bind(userId);

it.live(
  "prepares one-time recovery disclosure without persisting it before the stable-User batch commits",
  () =>
    Effect.gen(function* () {
      const db = yield* setup;
      const prepared = yield* Effect.tryPromise(() =>
        prepareInitialBackupRecoveryCode({ db, userId: alice, createdAtMs: 1 })
      );
      expect(
        Option.isSome(Schema.decodeOption(BackupRecoveryCode)(prepared.backupRecoveryCode))
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM backup_recovery_credentials").first()
        )
      ).toEqual({ count: 0 });
      yield* Effect.tryPromise(() => db.batch([insertUser(db, alice), prepared.statement]));
      const hash = yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(prepared.backupRecoveryCode))
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT user_id, code_digest FROM backup_recovery_credentials").first()
        )
      ).toEqual({ user_id: alice, code_digest: Array.from(new Uint8Array(hash)) });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT code_digest FROM backup_recovery_credentials WHERE user_id = ?")
            .bind(bob)
            .first()
        )
      ).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM web_sessions").first()
        )
      ).toEqual({ count: 0 });
    })
);
