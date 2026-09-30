import { NodeFileSystem } from "@effect/platform-node";
import { Miniflare } from "miniflare";
import { afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { startBrowserPairing, redeemBrowserPairing } from "../browser-login/operations";
import { expect, it } from "@effect/vitest";
import { UserId } from "../../src/core/identity/reference";
import { BackupRecoveryCode } from "../../src/core/recovery/contract";
import { Effect, FileSystem, Option, Schema } from "effect";
import { handleSupportRecovery, prepareInitialBackupRecoveryCode } from "./operations";

const instances: Array<Miniflare> = [];
afterEach(() => vi.restoreAllMocks());
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
      .split(/;\s*\n(?=CREATE |ALTER |$)/u))
      yield* Effect.tryPromise(() => db.prepare(statement).run());
  }
  return db;
});
const alice = UserId.make("10000000-0000-4000-8000-000000000001");
const bob = UserId.make("10000000-0000-4000-8000-000000000002");
const insertUser = (db: D1Database, userId: UserId): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)"
    )
    .bind(userId);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.layer(NodeFileSystem.layer, { excludeTestServices: true })("Recovery D1", (it) => {
  it.effect(
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

  it.effect(
    "support approval preserves the User but cannot substitute another browser proof or disclose session authority",
    () =>
      Effect.gen(function* () {
        const db = yield* setup;
        const initial = yield* Effect.tryPromise(() =>
          prepareInitialBackupRecoveryCode({ db, userId: alice, createdAtMs: 1 })
        );
        yield* Effect.tryPromise(() =>
          db.batch([insertUser(db, alice), insertUser(db, bob), initial.statement])
        );
        const Pairing = Schema.Struct({
          pairingId: Schema.String,
          publicCode: Schema.String,
          privateVerifier: Schema.String,
        });
        const pairing = yield* Schema.decodeUnknownEffect(Pairing)(
          yield* Effect.tryPromise(() =>
            startBrowserPairing(db).then((response) => response.json())
          )
        );
        const other = yield* Schema.decodeUnknownEffect(Pairing)(
          yield* Effect.tryPromise(() =>
            startBrowserPairing(db).then((response) => response.json())
          )
        );
        const { privateKey, publicKey } = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
        const jwk = {
          ...(yield* Effect.tryPromise(() => exportJWK(publicKey))),
          kid: "recovery-owner-key",
          alg: "RS256",
          use: "sig",
        };
        vi.spyOn(globalThis, "fetch").mockImplementation(() =>
          Promise.resolve(Response.json({ keys: [jwk] }))
        );
        const config = {
          CLOUDFLARE_ACCESS_ISSUER: "https://recovery-owner.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUDIENCE: "recovery-owner",
        };
        const token = yield* Effect.tryPromise(() =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "recovery-owner-key" })
            .setIssuer(config.CLOUDFLARE_ACCESS_ISSUER)
            .setAudience(config.CLOUDFLARE_ACCESS_AUDIENCE)
            .setSubject("operator")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey)
        );
        const approved = yield* handleSupportRecovery({
          db,
          config,
          request: new Request("https://api.fidyapp.com/internal/support-recovery", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
            body: encodeJson({
              pairingCode: pairing.publicCode,
              backupRecoveryCode: initial.backupRecoveryCode,
            }),
          }),
        });
        expect(approved.status).toBe(200);
        expect(approved.headers.get("set-cookie")).toBeNull();
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM web_sessions").first()
          )
        ).toEqual({ count: 0 });
        const redeem = (proof: object): Promise<Response> =>
          redeemBrowserPairing({
            db,
            request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson(proof),
            }),
          });
        expect(
          (yield* Effect.tryPromise(() =>
            redeem({ pairingId: pairing.pairingId, privateVerifier: other.privateVerifier })
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() =>
            redeem({ pairingId: pairing.pairingId, privateVerifier: initial.backupRecoveryCode })
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() =>
            redeem({ pairingId: pairing.pairingId, privateVerifier: "x".repeat(600) })
          )).status
        ).toBe(400);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM web_sessions").first()
          )
        ).toEqual({ count: 0 });
        const valid = yield* Effect.tryPromise(() => redeem(pairing));
        expect(valid.status).toBe(200);
        expect(valid.headers.get("set-cookie")).toMatch(/^__Host-fidy_session=/u);
        expect((yield* Effect.tryPromise(() => redeem(pairing))).status).toBe(400);
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM web_sessions").first())
        ).toEqual({ user_id: alice });
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT count(*) AS count FROM users").first())
        ).toEqual({ count: 2 });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM whatsapp_identities").first()
          )
        ).toEqual({ count: 0 });
      })
  );
});
