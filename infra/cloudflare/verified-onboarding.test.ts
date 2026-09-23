// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";

const mfInstances: Array<Miniflare> = [];
const exchange = "10000000-0000-4000-8000-000000000001";
const enrollment = "10000000-0000-4000-8000-000000000002";
const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
let nextDatabase = 0;
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

// @effect-diagnostics-next-line asyncFunction:off
const setup = async (
  email = "person@example.test",
  bsuid = "person-1"
): Promise<{
  db: D1Database;
  send: (combinedCode: unknown) => Promise<Response>;
  sendRequest: (request: Request) => Promise<Response>;
}> => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: `verified-${++nextDatabase}`, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name: `verified-${nextDatabase}`,
          type: "worker",
        },
      },
    ],
  });
  mfInstances.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const applyMigration = (name: string): Promise<void> =>
    readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8").then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |$)/u)
        .reduce<Promise<void>>(
          (previous, statement) =>
            previous.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );
  // Applied migrations depend on the preceding schema, so they must run in order.
  await ["0003_pending_consent", "0004_onboarding_email", "0005_verified_onboarding"].reduce<
    Promise<void>
  >((previous, name) => previous.then(() => applyMigration(name)), Promise.resolve());
  // @effect-diagnostics-next-line globalDate:off
  const now = Date.now();
  await db
    .prepare(`INSERT INTO pending_consent_exchanges
    (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
     correlation_token,disclosure_json,disclosure_message_id,created_at_ms,disclosed_at_ms,
     decision_not_before_ms,expires_at_ms,state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted')`)
    .bind(
      exchange,
      "portfolio",
      bsuid,
      "phone",
      "initial",
      "a".repeat(64),
      "10000000-0000-4000-8000-000000000003",
      "{}",
      "disclosure",
      now - 100000,
      now - 90000,
      now - 80000,
      now - 100000 + 86400000
    )
    .run();
  // Enter the decision phase before recording the append-only accepted evidence.
  await db
    .prepare("UPDATE pending_consent_exchanges SET state = 'awaiting_decision' WHERE id = ?")
    .bind(exchange)
    .run();
  await db
    .prepare(`INSERT INTO pending_consent_decisions
    (exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,
     decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      exchange,
      "portfolio",
      bsuid,
      "phone",
      "accepted",
      "{}",
      "disclosure",
      "decision",
      "delivery",
      "b".repeat(64),
      now - 71000,
      now - 70000
    )
    .run();
  await db
    .prepare(`INSERT INTO pending_email_enrollments
    (id,exchange_id,email_address,submission_message_id,submission_body_sha256,created_at_ms,
     expires_at_ms,state,public_code,proof_digest,proof_expires_at_ms)
    VALUES (?,?,?,?,?,?,?,'awaiting_proof',?,?,?)`)
    .bind(
      enrollment,
      exchange,
      email,
      "email",
      "c".repeat(64),
      now - 60000,
      now + 600000,
      "ABCD-EFGH",
      await digest("JKLM-NPQR-STUV-WXYZ"),
      now + 600000
    )
    .run();
  const sendRequest = (request: Request): Promise<Response> =>
    publicWorker.fetch(request, {
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      LOCAL_CANONICAL_READ_BEARER: "",
      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      CORE: {
        fetch: (request) =>
          coreWorker.fetch(new Request(request), {
            DB: db,
            AI: { run: () => Promise.reject(new Error("unused")) },
            CONTRACT_DIGEST: "a".repeat(64),
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            KAPSO_API_KEY: "",
            KAPSO_WEBHOOK_SECRET: "",
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
          }),
      },
    });
  const send = (combinedCode: unknown): Promise<Response> =>
    sendRequest(
      new Request("https://api.fidyapp.com/web/onboarding/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
        body: JSON.stringify({ combinedCode }),
      })
    );
  return { db, send, sendRequest };
};

// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  await Promise.all(mfInstances.splice(0).map((mf) => mf.dispose()));
});

// @effect-diagnostics-next-line asyncFunction:off
it("creates one complete stable identity on first valid mailbox proof and refuses replay", async () => {
  const { db, send } = await setup();
  const first = await send(code);
  expect(first.status).toBe(200);
  const created: { status: string; backupRecoveryCode: string } = await first.json();
  expect(created.status).toBe("created");
  expect((await send(code)).status).toBe(400);
  const result = await db
    .prepare(`SELECT u.service_market, u.locale, u.time_zone,
    w.portfolio_id, w.bsuid, v.email_address, c.disclosure_message_id,
    c.decision_message_id, c.decision_received_at_ms, c.accepted_at_ms,
    t.started_at_ms, t.ends_at_ms, b.code_digest,
    x.enrollment_id
    FROM users AS u JOIN whatsapp_identities AS w ON w.user_id = u.id
    JOIN verified_email_credentials AS v ON v.user_id = u.id
    JOIN onboarding_consent_records AS c ON c.user_id = u.id
    JOIN trial_periods AS t ON t.user_id = u.id
    JOIN backup_recovery_credentials AS b ON b.user_id = u.id
    JOIN completed_email_enrollments AS x ON x.user_id = u.id`)
    .first<{
      ends_at_ms: number;
      started_at_ms: number;
      code_digest: Array<number>;
      accepted_at_ms: number;
      decision_received_at_ms: number;
    }>();
  expect(result).toMatchObject({
    service_market: "CO",
    locale: "es-CO",
    time_zone: "America/Bogota",
    portfolio_id: "portfolio",
    bsuid: "person-1",
    email_address: "person@example.test",
    disclosure_message_id: "disclosure",
    decision_message_id: "decision",
    enrollment_id: enrollment,
  });
  expect(result).not.toBeNull();
  if (result !== null) {
    expect(result.ends_at_ms - result.started_at_ms).toBe(604_800_000);
    expect(result.accepted_at_ms).toBe(result.decision_received_at_ms - 1000);
    expect(result.code_digest).toEqual(Array.from(await digest(created.backupRecoveryCode)));
  }
  expect(
    await db.prepare("SELECT proof_digest, public_code FROM pending_email_enrollments").first()
  ).toMatchObject({ proof_digest: null, public_code: null });
  await db.prepare("DELETE FROM pending_consent_exchanges WHERE id = ?").bind(exchange).run();
  expect(
    (
      await db
        .prepare("SELECT count(*) AS count FROM onboarding_consent_records")
        .first<{ count: number }>()
    )?.count
  ).toBe(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects incorrect proofs and conflicting global mailbox ownership without partial identity", async () => {
  const { db, send } = await setup();
  expect((await send("ABCD-EFGH-JKLM-NPQR-STUV-WXY2")).status).toBe(400);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(0);
  await db
    .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
    .bind("10000000-0000-4000-8000-000000000004", 1)
    .run();
  await db
    .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
    .bind("10000000-0000-4000-8000-000000000004", "person@example.test", 1)
    .run();
  expect((await send(code)).status).toBe(400);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(1);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS count FROM completed_email_enrollments")
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses an already-owned WhatsAppIdentity without consuming another User's proof", async () => {
  const { db, send } = await setup();
  const other = "10000000-0000-4000-8000-000000000004";
  await db
    .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
    .bind(other, 1)
    .run();
  await db
    .prepare("INSERT INTO whatsapp_identities VALUES (?, ?, ?, ?)")
    .bind(other, "portfolio", "person-1", 1)
    .run();
  expect((await send(code)).status).toBe(400);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(1);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS count FROM completed_email_enrollments")
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("serializes simultaneous redemptions so only one User receives the proof", async () => {
  const { db, send } = await setup();
  const results = await Promise.all([send(code), send(code)]);
  expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([
    200, 400,
  ]);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("bounds failed mailbox proofs and never creates a User after the fourth attempt", async () => {
  const { db, send } = await setup();
  const wrong = "ABCD-EFGH-JKLM-NPQR-STUV-WXY2";
  const attempts = await Promise.all([send(wrong), send(wrong), send(wrong), send(wrong)]);
  expect(attempts.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  expect((await send(code)).status).toBe(400);
  expect(
    await db
      .prepare("SELECT wrong_proof_attempts, proof_digest FROM pending_email_enrollments")
      .first()
  ).toMatchObject({ wrong_proof_attempts: 4, proof_digest: null });
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects an oversized streaming request before it can reach D1", async () => {
  const { db, sendRequest } = await setup();
  const oversized = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new Uint8Array(513));
      controller.close();
    },
  });
  const result = await sendRequest(
    new Request("https://api.fidyapp.com/web/onboarding/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
      body: oversized,
      duplex: "half",
    })
  );
  expect(result.status).toBe(400);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses expired proof and a withdrawn pending Consent decision without creating a User", async () => {
  const { db, send } = await setup();
  await db
    .prepare("UPDATE pending_email_enrollments SET proof_expires_at_ms = ? WHERE id = ?")
    .bind(1, enrollment)
    .run();
  expect((await send(code)).status).toBe(400);
  await db
    .prepare(
      "UPDATE pending_email_enrollments SET proof_expires_at_ms = expires_at_ms WHERE id = ?"
    )
    .bind(enrollment)
    .run();
  await db
    .prepare("UPDATE pending_consent_exchanges SET state = 'declined' WHERE id = ?")
    .bind(exchange)
    .run();
  expect((await send(code)).status).toBe(400);
  expect(
    (await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>())?.count
  ).toBe(0);
});
