import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { BackupRecoveryCode } from "../../src/core/recovery/contract";
import { Option, Schema } from "effect";
import { prepareInitialBackupRecoveryCode } from "./operations";

const instances: Array<Miniflare> = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});
const setup = async (): Promise<D1Database> => {
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
  await instance.ready;
  const db = await instance.getD1Database("DB");
  for (const name of [
    "0003_pending_consent",
    "0004_onboarding_email",
    "0005_verified_onboarding",
    "0006_browser_login",
    "0007_browser_pairing_email",
    "0008_support_recovery",
  ]) {
    const sql = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
    for (const statement of sql
      .replace(/^--.*$/gmu, "")
      .trim()
      .split(/;\s*\n(?=CREATE |ALTER |$)/u)) {
      await db.prepare(statement).run();
    }
  }
  return db;
};
const alice = UserId.make("10000000-0000-4000-8000-000000000001");
const bob = UserId.make("10000000-0000-4000-8000-000000000002");
const insertUser = (db: D1Database, userId: UserId): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)"
    )
    .bind(userId);

it("prepares one-time recovery disclosure without persisting it before the stable-User batch commits", async () => {
  const db = await setup();
  const prepared = await prepareInitialBackupRecoveryCode({ db, userId: alice, createdAtMs: 1 });
  expect(
    Option.isSome(Schema.decodeUnknownOption(BackupRecoveryCode)(prepared.backupRecoveryCode))
  ).toBe(true);
  expect(
    await db.prepare("SELECT count(*) AS count FROM backup_recovery_credentials").first()
  ).toEqual({ count: 0 });
  await db.batch([insertUser(db, alice), prepared.statement]);
  const expectedDigest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prepared.backupRecoveryCode))
    )
  );
  expect(
    await db.prepare("SELECT user_id, code_digest FROM backup_recovery_credentials").first()
  ).toEqual({ user_id: alice, code_digest: expectedDigest });
  expect(
    await db
      .prepare("SELECT code_digest FROM backup_recovery_credentials WHERE user_id = ?")
      .bind(bob)
      .first()
  ).toBeNull();
  expect(await db.prepare("SELECT count(*) AS count FROM web_sessions").first()).toEqual({
    count: 0,
  });
});
