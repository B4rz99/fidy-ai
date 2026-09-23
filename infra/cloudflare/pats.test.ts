// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import * as D1Client from "@effect/sql-d1/D1Client";
import { listCategoriesResponse } from "@fidy/server/categories";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it, vi } from "vitest";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { UserTransactionCoordinator } from "./transaction-coordinator";

const instances: Array<Miniflare> = [];
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const Started = Schema.Struct({
  pairingId: Schema.String,
  privateDeviceCode: Schema.String,
  publicCode: Schema.String,
});
const Review = Schema.Struct({
  data: Schema.Struct({
    pairingId: Schema.String,
    scopes: Schema.Array(Schema.String),
    lifetimeDays: Schema.Number,
  }),
});
const Issued = Schema.Struct({
  pat: Schema.Struct({
    shortId: Schema.String,
    createdAt: Schema.String,
    expiresAt: Schema.String,
  }),
  bearer: Schema.String,
});
const dig = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));
// @effect-diagnostics-next-line globalDate:off
const clock = (): number => Date.now();
type Send = Readonly<{ path: string; method: "GET" | "POST" | "DELETE" }> &
  Partial<
    Readonly<{ payload: object; session: string; bearer: string; origin: string; source: string }>
  >;
const setup = async (): Promise<{
  db: D1Database;
  send: (input: Send) => Promise<Response>;
  sessions: readonly [string, string];
  scheduled: () => Promise<void>;
}> => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "pats", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch(){return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name: "pats",
          type: "worker",
        },
      },
    ],
  });
  instances.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const migrationNames = [
    "0001_categories",
    "0002_resource_admission",
    "0003_pending_consent",
    "0004_onboarding_email",
    "0005_verified_onboarding",
    "0006_browser_login",
    "0007_browser_pairing_email",
    "0008_support_recovery",
    "0009_email_replacement",
    "0009_pats",
    "0009_transactions",
    "0010_pat_revocation_consents",
    "0011_explicit_consent_revocations",
    "0012_pat_work_budget",
    "0013_pat_atomic_assertion",
    "0014_canonical_category_budget",
    "0015_transaction_capture_assertion",
  ];
  await migrationNames.reduce<Promise<void>>(async (previous, name) => {
    await previous;
    const sql = await readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
    await sql
      .replace(/^--.*$/gmu, "")
      .trim()
      .split(/;\s*\n(?=CREATE |ALTER |$)/u)
      .reduce<Promise<void>>(
        (prior, statement) => prior.then(() => db.prepare(statement).run()).then(() => undefined),
        Promise.resolve()
      );
  }, Promise.resolve());
  const createSession = async (user: string, index: number): Promise<string> => {
    const current = clock();
    const token = String(index).repeat(43);
    const pairing = `30000000-0000-4000-8000-00000000000${index}`;
    const session = `40000000-0000-4000-8000-00000000000${index}`;
    await db
      .prepare(
        "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
      )
      .bind(user, current)
      .run();
    await db
      .prepare(`INSERT INTO browser_login_pairings (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms)
      VALUES (?,?,?,?,'consumed',?,?)`)
      .bind(pairing, `BCDF-GHJ${index}`, await dig(token), user, current - 1_000, current + 599_000)
      .run();
    await db
      .prepare(`INSERT INTO web_sessions (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(
        session,
        pairing,
        user,
        await dig(token),
        current,
        current + 600_000,
        current + 2_592_000_000,
        current + 7_776_000_000
      )
      .run();
    return `__Host-fidy_session=${token}`;
  };
  const sessions = [await createSession(userA, 1), await createSession(userB, 2)] as const;
  const coordinators = new Map<string, UserTransactionCoordinator>();
  const coreEnvironment = {
    DB: db,
    USER_TRANSACTION_COORDINATOR: {
      getByName: (name: string): Pick<Fetcher, "fetch"> => {
        let coordinator = coordinators.get(name);
        if (coordinator === undefined) {
          coordinator = new UserTransactionCoordinator({ id: { name } }, { DB: db });
          coordinators.set(name, coordinator);
        }
        return { fetch: (input) => coordinator.fetch(new Request(input)) };
      },
    },
    AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
    CONTRACT_DIGEST: "a".repeat(64),
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    HOSTED_AI_MODEL: approvedWorkersAiModel,
    KAPSO_API_KEY: "",
    KAPSO_WEBHOOK_SECRET: "unused",
    WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
    CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "test",
  };
  const scheduled = (): Promise<void> =>
    coreWorker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: clock(),
        noRetry: () => {},
      },
      coreEnvironment
    );
  const send = ({
    path,
    method,
    payload,
    session,
    bearer,
    source = "198.51.100.10",
    origin = "https://app.fidyapp.com",
  }: Send): Promise<Response> => {
    const headers = new Headers({ origin, "cf-connecting-ip": source });
    if (payload !== undefined) headers.set("content-type", "application/json");
    if (session !== undefined) headers.set("cookie", session);
    if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
    const request = new Request(`https://api.fidyapp.com${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return publicWorker.fetch(request, {
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      CORE: {
        fetch: (incoming) => coreWorker.fetch(new Request(incoming), coreEnvironment),
      },
    });
  };
  return { db, send, sessions, scheduled };
};
// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});

it("releases one scoped bearer to the private-code holder after web approval, never on replay", async () => {
  const { db, send, sessions } = await setup();
  const start = await send({
    path: "/pat-pairings",
    method: "POST",
    payload: { recipientLabel: "My agent", scopes: ["read"], lifetimeDays: 7 },
  });
  expect(start.status).toBe(200);
  const created = Schema.decodeUnknownSync(Started)(await start.json());
  expect(
    (
      await send({
        path: "/pat-pairings/claim",
        method: "POST",
        payload: { pairingId: created.pairingId, privateDeviceCode: "x".repeat(43) },
      })
    ).status
  ).toBe(400);
  const reviewResponse = await send({
    path: "/pats/pairings/inspect",
    method: "POST",
    payload: { publicCode: created.publicCode },
    session: sessions[0],
  });
  expect(reviewResponse.status).toBe(200);
  const review = Schema.decodeUnknownSync(Review)(await reviewResponse.json()).data;
  expect(review).toMatchObject({ scopes: ["read"], lifetimeDays: 7 });
  const rejectedOrigin = await send({
    path: "/pats/pairings/approve",
    method: "POST",
    payload: { pairingId: review.pairingId },
    session: sessions[0],
    origin: "https://evil.example",
  });
  expect(rejectedOrigin.status).toBe(403);
  expect(
    (await db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(review.pairingId).first())
      ?.state
  ).toBe("pending_approval");
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first())?.total
  ).toBe(0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock() + 240_000);
  const approval = await send({
    path: "/pats/pairings/approve",
    method: "POST",
    payload: { pairingId: review.pairingId },
    session: sessions[0],
  });
  expect(approval.status).toBe(200);
  const proof = { pairingId: created.pairingId, privateDeviceCode: created.privateDeviceCode };
  const claim = await send({ path: "/pat-pairings/claim", method: "POST", payload: proof });
  expect(claim.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Issued)(await claim.json());
  expect(issued.bearer).toMatch(/^fin_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/u);
  expect(Date.parse(issued.pat.expiresAt) - Date.parse(issued.pat.createdAt)).toBe(7 * 86_400_000);
  expect((await send({ path: "/pat-pairings/claim", method: "POST", payload: proof })).status).toBe(
    400
  );
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
        .bind(created.pairingId)
        .first()
    )?.total
  ).toBe(1);
  expect(
    (
      await db
        .prepare("SELECT bearer_digest FROM pats WHERE pairing_id = ?")
        .bind(created.pairingId)
        .first()
    )?.bearer_digest
  ).not.toBe(issued.bearer);
});

it("refuses a source's PAT pairing burst without denying an unrelated client", async () => {
  const { send } = await setup();
  const attempt = (source: string): Promise<Response> =>
    send({
      path: "/pat-pairings",
      method: "POST",
      source,
      payload: { recipientLabel: "Desktop agent", scopes: ["read"] },
    });
  const admitted = await Promise.all(Array.from({ length: 20 }, () => attempt("198.51.100.10")));
  expect(admitted.map((result) => result.status)).toEqual(Array.from({ length: 20 }, () => 200));
  expect((await attempt("198.51.100.10")).status).toBe(429);
  expect((await attempt("203.0.113.20")).status).toBe(200);
});

it("sweeps expired anonymous pairing metadata but preserves approved grant evidence", async () => {
  const { db, send, scheduled, sessions } = await setup();
  const grant = { recipientLabel: "Desktop agent", scopes: ["read"], lifetimeDays: 7 };
  const pending = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: grant,
      })
    ).json()
  );
  const approved = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: grant,
      })
    ).json()
  );
  const review = Schema.decodeUnknownSync(Review)(
    await (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: approved.publicCode },
      })
    ).json()
  ).data;
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: review.pairingId },
      })
    ).status
  ).toBe(200);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock() + 600_001);
  await scheduled();
  expect(
    await db.prepare("SELECT 1 FROM pat_pairings WHERE id = ?").bind(pending.pairingId).first()
  ).toBeNull();
  expect(
    await db.prepare("SELECT 1 FROM pat_pairings WHERE id = ?").bind(approved.pairingId).first()
  ).not.toBeNull();
  expect(
    await db
      .prepare("SELECT 1 FROM pat_grant_consents WHERE pairing_id = ?")
      .bind(approved.pairingId)
      .first()
  ).not.toBeNull();
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(approved.pairingId)
        .first()
    )?.state
  ).toBe("revoked_unclaimed");
  expect(
    await db
      .prepare("SELECT policy_reason,session_id FROM pat_revocation_consents WHERE pairing_id = ?")
      .bind(approved.pairingId)
      .first()
  ).toMatchObject({
    policy_reason: "pat-approved-unclaimed-expiry",
    session_id: null,
  });
  await scheduled();
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_revocation_consents WHERE pairing_id = ?")
        .bind(approved.pairingId)
        .first()
    )?.total
  ).toBe(1);
});

it("atomically revokes claimable approvals with User-origin Consent evidence and blocks late claims", async () => {
  const { db, send, sessions } = await setup();
  const started = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: { recipientLabel: "Agent", scopes: ["read"] },
      })
    ).json()
  );
  const review = Schema.decodeUnknownSync(Review)(
    await (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: started.publicCode },
      })
    ).json()
  ).data;
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: review.pairingId },
      })
    ).status
  ).toBe(200);
  expect((await send({ path: "/pats", method: "DELETE", session: sessions[1] })).status).toBe(200);
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(started.pairingId)
        .first()
    )?.state
  ).toBe("approved_awaiting_claim");
  await db
    .prepare(`CREATE TRIGGER test_revoke_all_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
    .run();
  expect((await send({ path: "/pats", method: "DELETE", session: sessions[0] })).status).toBe(503);
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(started.pairingId)
        .first()
    )?.state
  ).toBe("approved_awaiting_claim");
  await db.prepare("DROP TRIGGER test_revoke_all_failure").run();
  expect((await send({ path: "/pats", method: "DELETE", session: sessions[0] })).status).toBe(200);
  expect((await send({ path: "/pats", method: "DELETE", session: sessions[0] })).status).toBe(200);
  expect(
    await db
      .prepare("SELECT session_id,policy_reason FROM pat_revocation_consents WHERE pairing_id = ?")
      .bind(started.pairingId)
      .first()
  ).toMatchObject({
    session_id: "40000000-0000-4000-8000-000000000001",
    policy_reason: null,
  });
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first())?.total
  ).toBe(1);
  expect(
    (
      await send({
        path: "/pat-pairings/claim",
        method: "POST",
        payload: { pairingId: started.pairingId, privateDeviceCode: started.privateDeviceCode },
      })
    ).status
  ).toBe(400);
});

it("bounds per-User issuance even when every PAT is revoked immediately", async () => {
  const { db, send, sessions } = await setup();
  const grant = { recipientLabel: "Cycling client", scopes: ["read"], lifetimeDays: 7 };
  const manualGrant = {
    ...grant,
    reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
  };
  await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const response = await send({
        path: "/pats",
        method: "POST",
        session: sessions[0],
        payload: {
          requestId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          grant: manualGrant,
        },
      });
      expect(response.status).toBe(200);
      expect((await send({ path: "/pats", method: "DELETE", session: sessions[0] })).status).toBe(
        200
      );
    })
  );
  const denied = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: { requestId: "00000000-0000-4000-8000-000000000020", grant: manualGrant },
  });
  expect(denied.status).toBe(429);
  expect((await db.prepare("SELECT count(*) AS total FROM pats").first())?.total).toBe(20);
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first())?.total
  ).toBe(20);
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first())?.total
  ).toBe(20);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_audit WHERE operation = 'pats.createManualPAT'")
        .first()
    )?.total
  ).toBe(20);
  const started = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: grant,
      })
    ).json()
  );
  const review = Schema.decodeUnknownSync(Review)(
    await (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: started.publicCode },
      })
    ).json()
  ).data;
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: review.pairingId },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await send({
        path: "/pat-pairings/claim",
        method: "POST",
        payload: { pairingId: started.pairingId, privateDeviceCode: started.privateDeviceCode },
      })
    ).status
  ).toBe(400);
  expect((await db.prepare("SELECT count(*) AS total FROM pats").first())?.total).toBe(20);
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(started.pairingId)
        .first()
    )?.state
  ).toBe("approved_awaiting_claim");
  expect(
    (
      await send({
        path: "/pats",
        method: "POST",
        session: sessions[1],
        payload: { requestId: "00000000-0000-4000-8000-000000000020", grant: manualGrant },
      })
    ).status
  ).toBe(200);
});

it("rolls back revoke-one and retries exactly one append-only Consent revocation after storage recovers", async () => {
  const { db, send, sessions } = await setup();
  const grant = {
    recipientLabel: "Agent",
    scopes: ["read"],
    lifetimeDays: 7,
    reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
  };
  const created = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: { requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff", grant },
  });
  expect(created.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await created.json()
  ).data;
  await db
    .prepare(`CREATE TRIGGER test_revoke_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
    .run();
  const path = `/pats/${issued.pat.shortId}`;
  expect((await send({ path, method: "DELETE", session: sessions[0] })).status).toBe(503);
  expect(
    (
      await db
        .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.revoked_at_ms
  ).toBeNull();
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    200
  );
  await db.prepare("DROP TRIGGER test_revoke_failure").run();
  expect((await send({ path, method: "DELETE", session: sessions[0] })).status).toBe(200);
  expect((await send({ path, method: "DELETE", session: sessions[0] })).status).toBe(200);
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first())?.total
  ).toBe(1);
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    401
  );
});

it("atomically expires a fixed-lifetime PAT with policy-origin Consent evidence", async () => {
  const { db, send, scheduled, sessions } = await setup();
  const original = clock();
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed",
      grant: {
        recipientLabel: "Agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(original + 7 * 86_400_000)),
      },
    },
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(issued.pat.expiresAt) + 1);
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    401
  );
  await db
    .prepare(`CREATE TRIGGER test_expiry_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
    .run();
  await expect(scheduled()).rejects.toThrow();
  expect(
    (
      await db
        .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.revoked_at_ms
  ).toBeNull();
  await db.prepare("DROP TRIGGER test_expiry_failure").run();
  await db
    .prepare(`CREATE TRIGGER ignore_expiry_transition BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  await expect(scheduled()).rejects.toThrow();
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_revocation_consents")
        .first<{ total: number }>()
    )?.total
  ).toBe(0);
  await db.prepare("DROP TRIGGER ignore_expiry_transition").run();
  await scheduled();
  await scheduled();
  expect(
    await db
      .prepare(`SELECT r.policy_reason,r.session_id FROM pat_revocation_consents r
    JOIN pats p ON p.id = r.pat_id WHERE p.short_id = ?`)
      .bind(issued.pat.shortId)
      .first()
  ).toMatchObject({
    policy_reason: "pat-fixed-lifetime-expiry",
    session_id: null,
  });
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first())?.total
  ).toBe(1);
});

it("serializes concurrent private-code claims so only one bearer is ever issued", async () => {
  const { db, send, sessions } = await setup();
  const started = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: { recipientLabel: "Agent", scopes: ["read"] },
      })
    ).json()
  );
  const review = Schema.decodeUnknownSync(Review)(
    await (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        payload: { publicCode: started.publicCode },
        session: sessions[0],
      })
    ).json()
  ).data;
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: review.pairingId },
      })
    ).status
  ).toBe(200);
  const proof = { pairingId: started.pairingId, privateDeviceCode: started.privateDeviceCode };
  const results = await Promise.all([
    send({ path: "/pat-pairings/claim", method: "POST", payload: proof }),
    send({ path: "/pat-pairings/claim", method: "POST", payload: proof }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
        .bind(started.pairingId)
        .first()
    )?.total
  ).toBe(1);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_grant_consents WHERE pairing_id = ?")
        .bind(started.pairingId)
        .first()
    )?.total
  ).toBe(1);
});

it("isolates management by User and immediately refuses revoked and under-scoped PATs", async () => {
  const { db, send, sessions } = await setup();
  const payload = {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    grant: {
      recipientLabel: "My reader",
      scopes: ["read"],
      lifetimeDays: 7,
      reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
    },
  };
  const stale = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      grant: { ...payload.grant, reviewExpiresAt: "2020-01-01T00:00:00.000Z" },
    },
  });
  expect(stale.status).toBe(422);
  expect(await stale.json()).toMatchObject({ error: { code: "user_action_required" }, next: [] });
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    payload,
    session: sessions[0],
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  const replay = await send({ path: "/pats", method: "POST", payload, session: sessions[0] });
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "user_action_required" }, next: [] });
  expect((await send({ path: "/pats", method: "GET", session: sessions[1] })).status).toBe(200);
  const ownedList = await send({ path: "/pats", method: "GET", session: sessions[0] });
  expect(ownedList.status).toBe(200);
  const safeMetadata = await ownedList.text();
  expect(safeMetadata).toContain(issued.pat.shortId);
  expect(safeMetadata).not.toContain(issued.bearer);
  const foreign = await send({
    path: `/pats/${issued.pat.shortId}`,
    method: "DELETE",
    session: sessions[1],
  });
  expect(foreign.status).toBe(404);
  expect(
    (
      await db
        .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.revoked_at_ms
  ).toBeNull();
  expect(
    (await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status
  ).not.toBe(401);
  expect(
    (await send({ path: `/pats/${issued.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(200);
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    401
  );
  expect(
    await db
      .prepare(`SELECT r.session_id,r.policy_reason FROM pat_revocation_consents r
    JOIN pats p ON p.id = r.pat_id WHERE p.short_id = ?`)
      .bind(issued.pat.shortId)
      .first()
  ).toMatchObject({ session_id: "40000000-0000-4000-8000-000000000001", policy_reason: null });
  expect(
    (await send({ path: `/pats/${issued.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(200);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_revocation_consents WHERE pat_id IS NOT NULL")
        .first()
    )?.total
  ).toBe(1);
  const writer = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      grant: {
        recipientLabel: "Writer",
        scopes: ["write"],
        lifetimeDays: 30,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 30 * 86_400_000)),
      },
    },
  });
  expect(writer.status).toBe(200);
  const writerBearer = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await writer.json()
  ).data.bearer;
  const underScoped = await send({ path: "/categories", method: "GET", bearer: writerBearer });
  expect(underScoped.status).toBe(403);
  expect(await underScoped.json()).toMatchObject({ error: { code: "scope_missing" }, next: [] });
  await db
    .prepare("UPDATE pats SET revoked_at_ms = ? WHERE bearer_digest = ?")
    .bind(clock(), await dig(writerBearer))
    .run();
  const revokedWriter = await send({ path: "/categories", method: "GET", bearer: writerBearer });
  expect(revokedWriter.status).toBe(401);
  expect(await revokedWriter.json()).toMatchObject({ error: { code: "unauthenticated" } });
});

it("mints manual PATs for the complete selected lifetime from issuance", async () => {
  const { send, sessions } = await setup();
  const current = clock();
  const grant = {
    recipientLabel: "Reviewed agent",
    scopes: ["read"],
    lifetimeDays: 7,
    reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 7 * 86_400_000)),
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(current + 120_000);
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", grant },
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  expect(Date.parse(issued.pat.expiresAt) - Date.parse(issued.pat.createdAt)).toBe(7 * 86_400_000);
});

it("does not leave revoke-all Consent evidence when the PAT transition is refused", async () => {
  const { db, send, sessions } = await setup();
  const issued = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "70000000-0000-4000-8000-000000000052",
      grant: {
        recipientLabel: "Agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(issued.status).toBe(200);
  const token = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(await issued.json()).data;
  await db
    .prepare(`CREATE TRIGGER refuse_all_revocations BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const revoked = await send({ path: "/pats", method: "DELETE", session: sessions[0] });
  expect(revoked.status).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_revocation_consents")
        .first<{ total: number }>()
    )?.total
  ).toBe(0);
  expect((await send({ path: "/categories", method: "GET", bearer: token.bearer })).status).toBe(
    200
  );
});

it("does not append revocation Consent when the PAT transition silently fails", async () => {
  const { db, send, sessions } = await setup();
  const issued = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "70000000-0000-4000-8000-000000000051",
      grant: {
        recipientLabel: "Agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(issued.status).toBe(200);
  const token = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(await issued.json()).data;
  await db
    .prepare(`CREATE TRIGGER refuse_pat_revocation BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const revoked = await send({
    path: `/pats/${token.pat.shortId}`,
    method: "DELETE",
    session: sessions[0],
  });
  expect(revoked.status).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_revocation_consents")
        .first<{ total: number }>()
    )?.total
  ).toBe(0);
  expect((await send({ path: "/categories", method: "GET", bearer: token.bearer })).status).toBe(
    200
  );
});

it("retries a claim without losing its approval when the claim AuditLogEntry is refused", async () => {
  const { db, send, sessions } = await setup();
  const started = await send({
    path: "/pat-pairings",
    method: "POST",
    payload: {
      recipientLabel: "Agent",
      scopes: ["read"],
      lifetimeDays: 7,
    },
  });
  expect(started.status).toBe(200);
  const pairing = Schema.decodeUnknownSync(Started)(await started.json());
  expect(
    (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: pairing.publicCode },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: pairing.pairingId },
      })
    ).status
  ).toBe(200);
  await db
    .prepare(`CREATE TRIGGER refuse_claim_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'pats.claim' BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const proof = { pairingId: pairing.pairingId, privateDeviceCode: pairing.privateDeviceCode };
  expect(
    (await send({ path: "/pat-pairings/claim", method: "POST", payload: proof })).status
  ).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(pairing.pairingId)
        .first<{ state: string }>()
    )?.state
  ).toBe("approved_awaiting_claim");
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pats").first<{ total: number }>())?.total
  ).toBe(0);
  await db.prepare("DROP TRIGGER refuse_claim_audit").run();
  expect((await send({ path: "/pat-pairings/claim", method: "POST", payload: proof })).status).toBe(
    200
  );
});

it("keeps a PATPairing pending when its approval ConsentRecord is silently refused", async () => {
  const { db, send, sessions } = await setup();
  const started = await send({
    path: "/pat-pairings",
    method: "POST",
    payload: {
      recipientLabel: "Agent",
      scopes: ["read"],
      lifetimeDays: 7,
    },
  });
  expect(started.status).toBe(200);
  const pairing = Schema.decodeUnknownSync(Started)(await started.json());
  expect(
    (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: pairing.publicCode },
      })
    ).status
  ).toBe(200);
  await db
    .prepare(`CREATE TRIGGER refuse_pairing_grant BEFORE INSERT ON pat_grant_consents
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const approval = await send({
    path: "/pats/pairings/approve",
    method: "POST",
    session: sessions[0],
    payload: { pairingId: pairing.pairingId },
  });
  expect(approval.status).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT state FROM pat_pairings WHERE id = ?")
        .bind(pairing.pairingId)
        .first<{ state: string }>()
    )?.state
  ).toBe("pending_approval");
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_grant_consents")
        .first<{ total: number }>()
    )?.total
  ).toBe(0);
});

it("does not commit a PAT when its ConsentRecord is silently refused", async () => {
  const { db, send, sessions } = await setup();
  await db
    .prepare(`CREATE TRIGGER refuse_pat_grant BEFORE INSERT ON pat_grant_consents
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const response = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "70000000-0000-4000-8000-000000000050",
      grant: {
        recipientLabel: "My agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(response.status).not.toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain("fin_");
  expect(
    (await db.prepare("SELECT count(*) AS total FROM pats").first<{ total: number }>())?.total
  ).toBe(0);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_grant_consents")
        .first<{ total: number }>()
    )?.total
  ).toBe(0);
});

it("bounds canonical work across a stable User and multiple PATs", async () => {
  const { db, send, sessions } = await setup();
  const issue = async (requestId: string): Promise<typeof Issued.Type> => {
    const result = await send({
      path: "/pats",
      method: "POST",
      session: sessions[0],
      payload: {
        requestId,
        grant: {
          recipientLabel: "Budgeted agent",
          scopes: ["read"],
          lifetimeDays: 7,
          reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
        },
      },
    });
    expect(result.status).toBe(200);
    return Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(await result.json()).data;
  };
  const first = await issue("70000000-0000-4000-8000-000000000031");
  const second = await issue("70000000-0000-4000-8000-000000000032");
  expect((await send({ path: "/transactions", method: "GET", bearer: first.bearer })).status).toBe(
    200
  );
  expect((await send({ path: "/transactions", method: "GET", bearer: second.bearer })).status).toBe(
    200
  );
  const pat = await db
    .prepare("SELECT id FROM pats WHERE short_id = ?")
    .bind(second.pat.shortId)
    .first<{ id: string }>();
  expect(pat).not.toBeNull();
  await db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 254)
    INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT lower(hex(randomblob(16))), ?, ?, 'transactions.listTransactions', 'accepted', ? FROM seq`)
    .bind(userA, pat?.id, clock())
    .run();
  const count = (
    await db
      .prepare(
        "SELECT count(*) AS total FROM pat_audit WHERE user_id = ? AND operation = 'transactions.listTransactions'"
      )
      .bind(userA)
      .first<{ total: number }>()
  )?.total;
  expect(count).toBe(256);
  expect((await send({ path: "/transactions", method: "GET", bearer: first.bearer })).status).toBe(
    429
  );
  expect((await send({ path: "/transactions", method: "GET", bearer: second.bearer })).status).toBe(
    429
  );
  expect((await send({ path: "/transactions", method: "GET", session: sessions[0] })).status).toBe(
    429
  );
  expect(
    (
      await db
        .prepare(
          "SELECT count(*) AS total FROM pat_audit WHERE user_id = ? AND operation = 'transactions.listTransactions'"
        )
        .bind(userA)
        .first<{ total: number }>()
    )?.total
  ).toBe(count);
});

it("gates every declared canonical path by live PAT and exact operation scope before any unavailable adapter", async () => {
  const { db, send, sessions } = await setup();
  const issue = async (
    scope: "read" | "write" | "dashboard",
    index: number
  ): Promise<typeof Issued.Type> => {
    const response = await send({
      path: "/pats",
      method: "POST",
      session: sessions[0],
      payload: {
        requestId: `70000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        grant: {
          recipientLabel: `Agent ${index}`,
          scopes: [scope],
          lifetimeDays: 7,
          reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
        },
      },
    });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(await response.json()).data;
  };
  const reader = await issue("read", 1);
  const writer = await issue("write", 2);
  const dashboard = await issue("dashboard", 3);
  const capture = {
    money: { amount: "2300.50", currency: "COP" },
    direction: "outflow",
    categoryId: "10000000-0000-4000-8000-000000000001",
    occurredAt: "2026-09-01T12:00:00.000Z",
  };
  expect(
    (await send({ path: "/transactions", method: "POST", bearer: reader.bearer, payload: capture }))
      .status
  ).toBe(403);
  const created = await send({
    path: "/transactions",
    method: "POST",
    bearer: writer.bearer,
    payload: capture,
  });
  expect(created.status).toBe(201);
  expect(
    (await send({ path: "/transactions", method: "POST", bearer: writer.bearer, payload: {} }))
      .status
  ).toBe(400);
  expect(
    (
      await db
        .prepare(
          "SELECT count(*) AS total FROM pat_audit WHERE operation = 'transactions.createTransaction' AND outcome = 'accepted'"
        )
        .first()
    )?.total
  ).toBe(1);
  const transactionId = "90000000-0000-4000-8000-000000000001";
  await db
    .prepare(`INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at)
    VALUES (?,?,?,'COP','outflow',?,'2026-09-01T12:00:00.000Z','2026-09-01T12:00:00.000Z')`)
    .bind(transactionId, userA, "1000.00", "10000000-0000-4000-8000-000000000001")
    .run();
  expect((await send({ path: "/transactions", method: "GET", bearer: writer.bearer })).status).toBe(
    403
  );
  const history = await send({ path: "/transactions", method: "GET", bearer: reader.bearer });
  expect(history.status).toBe(200);
  expect(JSON.stringify(await history.json())).toContain(transactionId);
  expect(
    (await send({ path: `/transactions/${transactionId}`, method: "GET", bearer: reader.bearer }))
      .status
  ).toBe(200);
  const foreignTransactionId = "90000000-0000-4000-8000-000000000002";
  await db
    .prepare(`INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at)
    VALUES (?,?,?,'COP','outflow',?,'2026-09-01T12:00:00.000Z','2026-09-01T12:00:00.000Z')`)
    .bind(foreignTransactionId, userB, "2000.00", "10000000-0000-4000-8000-000000000001")
    .run();
  const isolated = await send({ path: "/transactions", method: "GET", bearer: reader.bearer });
  expect(JSON.stringify(await isolated.json())).not.toContain(foreignTransactionId);
  expect(
    (
      await send({
        path: `/transactions/${foreignTransactionId}`,
        method: "GET",
        bearer: reader.bearer,
      })
    ).status
  ).toBe(404);
  expect((await send({ path: "/budgets", method: "GET", bearer: reader.bearer })).status).toBe(503);
  expect(
    (await send({ path: "/budgets", method: "POST", bearer: reader.bearer, payload: {} })).status
  ).toBe(403);
  expect(
    (await send({ path: "/budgets", method: "POST", bearer: writer.bearer, payload: {} })).status
  ).toBe(503);
  expect(
    (await send({ path: "/dashboard/edits", method: "POST", bearer: reader.bearer, payload: {} }))
      .status
  ).toBe(403);
  expect(
    (
      await send({
        path: "/dashboard/edits",
        method: "POST",
        bearer: dashboard.bearer,
        payload: {},
      })
    ).status
  ).toBe(503);
  expect(
    (await send({ path: "/transactions/foreign-id", method: "GET", bearer: writer.bearer })).status
  ).toBe(403);
  expect(
    (await send({ path: "/transactions/foreign-id", method: "GET", bearer: reader.bearer })).status
  ).toBe(404);
  expect((await send({ path: "/budgets", method: "GET", bearer: "fin_invalid" })).status).toBe(401);
  expect(
    (
      await send({
        path: "/budgets",
        method: "GET",
        bearer: reader.bearer,
        origin: "https://evil.example",
      })
    ).status
  ).toBe(403);
  expect(
    (await send({ path: `/pats/${reader.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(200);
  expect((await send({ path: "/budgets", method: "GET", bearer: reader.bearer })).status).toBe(401);
  expect((await send({ path: "/transactions", method: "GET", bearer: reader.bearer })).status).toBe(
    401
  );
  expect(
    (await send({ path: `/pats/${writer.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(200);
  expect(
    (await send({ path: "/transactions", method: "POST", bearer: writer.bearer, payload: capture }))
      .status
  ).toBe(401);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_audit WHERE operation = 'budgets.listBudgets'")
        .first()
    )?.total
  ).toBe(0);

  const stillLive = await issue("read", 4);
  const grantId = "e0000000-0000-4000-8000-000000000001";
  await db
    .prepare(`INSERT INTO onboarding_consent_records
    (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
    VALUES (?,?,'{}','disclosure','decision',?,?)`)
    .bind(grantId, userA, clock(), clock())
    .run();
  const [withdrawal, concurrentUse] = await Promise.all([
    db
      .prepare(`INSERT INTO consent_user_revocations
    (id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES (?,?,?,?,?)`)
      .bind(
        "e0000000-0000-4000-8000-000000000002",
        userA,
        grantId,
        "40000000-0000-4000-8000-000000000001",
        clock()
      )
      .run(),
    send({ path: "/transactions", method: "GET", bearer: stillLive.bearer }),
  ]);
  expect(withdrawal.meta.changes).toBe(1);
  expect([200, 403]).toContain(concurrentUse.status);
  const withdrawn = await send({ path: "/categories", method: "GET", bearer: stillLive.bearer });
  expect(withdrawn.status).toBe(403);
  expect(JSON.stringify(await withdrawn.json())).toContain("user_action_required");
  expect(
    (await send({ path: "/transactions", method: "GET", bearer: stillLive.bearer })).status
  ).toBe(403);
  expect((await send({ path: "/categories", method: "GET", bearer: "fin_invalid" })).status).toBe(
    401
  );
  const rejectedIssuance = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "70000000-0000-4000-8000-000000000005",
      grant: {
        recipientLabel: "Too late",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(rejectedIssuance.status).toBe(403);
  expect(JSON.stringify(await rejectedIssuance.json())).toContain("user_action_required");
  const pairingStart = await send({
    path: "/pat-pairings",
    method: "POST",
    payload: { recipientLabel: "Post-consent client", scopes: ["read"], lifetimeDays: 7 },
  });
  expect(pairingStart.status).toBe(200);
  const pending = Schema.decodeUnknownSync(Started)(await pairingStart.json());
  const deniedApproval = await send({
    path: "/pats/pairings/approve",
    method: "POST",
    session: sessions[0],
    payload: { pairingId: pending.pairingId },
  });
  expect(deniedApproval.status).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pat_grant_consents WHERE pairing_id = ?")
        .bind(pending.pairingId)
        .first()
    )?.total
  ).toBe(0);
  expect((await send({ path: "/transactions", method: "GET", session: sessions[0] })).status).toBe(
    401
  );
  expect(
    (await send({ path: "/transactions", method: "POST", session: sessions[0], payload: capture }))
      .status
  ).toBe(401);
  expect(
    (await db.prepare("SELECT count(*) AS total FROM source_attestations").first())?.total
  ).toBe(1);
});

it("rejects invalid grants, expired bearers and stale browser authority without partial effects", async () => {
  const { db, send, sessions } = await setup();
  const invalid = await send({
    path: "/pat-pairings",
    method: "POST",
    payload: { recipientLabel: "Nobody", scopes: [] },
  });
  expect(invalid.status).toBe(400);
  expect((await db.prepare("SELECT count(*) AS total FROM pat_pairings").first())?.total).toBe(0);
  const unreviewed = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      grant: { recipientLabel: "No review", scopes: ["read"], lifetimeDays: 7 },
    },
  });
  expect(unreviewed.status).toBe(400);
  expect((await db.prepare("SELECT count(*) AS total FROM pats").first())?.total).toBe(0);
  const response = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      grant: {
        recipientLabel: "Reader",
        scopes: ["write"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(response.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await response.json()
  ).data;
  const expired = await db
    .prepare(
      "UPDATE pats SET created_at_ms = created_at_ms - 691200000, expires_at_ms = expires_at_ms - 691200000 WHERE short_id = ?"
    )
    .bind(issued.pat.shortId)
    .run();
  expect(expired.meta.changes).toBe(1);
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    401
  );
  expect(
    (
      await db
        .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.last_used_at_ms
  ).toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(clock() + 601_000));
  expect((await send({ path: "/pats", method: "GET", session: sessions[0] })).status).toBe(200);
  expect(
    (await send({ path: `/pats/${issued.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(401);
  expect(
    (
      await db
        .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.revoked_at_ms
  ).toBeNull();
});

it("shares one Category projection and row codec between HTTP and the hosted-agent query", async () => {
  const { db, send, sessions } = await setup();
  const http = await send({ path: "/categories", method: "GET", session: sessions[0] });
  expect(http.status).toBe(200);
  const fromAgent = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(D1Client.layer({ db }));
        return yield* listCategoriesResponse.pipe(
          Effect.withTracerEnabled(false),
          Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient))
        );
      })
    )
  );
  expect(await http.json()).toEqual(fromAgent);
});

it("fails closed with declared unavailable for an authenticated WebSession whose canonical adapter is absent", async () => {
  const { send, sessions } = await setup();
  const authenticated = await send({ path: "/budgets", method: "GET", session: sessions[0] });
  expect(authenticated.status).toBe(503);
  expect(await authenticated.json()).toMatchObject({ error: { code: "unavailable" } });
  expect(
    (await send({ path: "/budgets", method: "GET", session: "__Host-fidy_session=invalid" })).status
  ).toBe(401);
});

it("does not commit PAT activity or disclose Category rows when its audit is silently refused", async () => {
  const { db, send, sessions } = await setup();
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "f0000000-0000-4000-8000-000000000002",
      grant: {
        recipientLabel: "Audited reader",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  await db
    .prepare(`CREATE TRIGGER ignore_category_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'categories.listCategories' BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  expect(
    (await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status
  ).not.toBe(200);
  expect(
    (
      await db
        .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
        .bind(issued.pat.shortId)
        .first()
    )?.last_used_at_ms
  ).toBeNull();
  await db.prepare("DROP TRIGGER ignore_category_audit").run();
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    200
  );
  expect(
    (
      await db
        .prepare(`SELECT count(*) AS total FROM pat_audit WHERE operation = 'categories.listCategories'
    AND pat_id = (SELECT id FROM pats WHERE short_id = ?)`)
        .bind(issued.pat.shortId)
        .first()
    )?.total
  ).toBe(1);
});

it("shares the Category work budget between WebSessions, PATs and Transaction work", async () => {
  const { db, send, sessions } = await setup();
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "f0000000-0000-4000-8000-000000000001",
      grant: {
        recipientLabel: "Category reader",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  await db.batch(
    Array.from({ length: 255 }, () =>
      db
        .prepare(`INSERT INTO transaction_audit
    (id,user_id,session_id,operation,outcome,occurred_at_ms)
    VALUES (?, ?, ?, 'transactions.listTransactions', 'success', ?)`)
        .bind(crypto.randomUUID(), userA, "40000000-0000-4000-8000-000000000001", clock())
    )
  );
  expect((await send({ path: "/categories", method: "GET", session: sessions[0] })).status).toBe(
    200
  );
  expect((await send({ path: "/categories", method: "GET", bearer: issued.bearer })).status).toBe(
    503
  );
  expect((await send({ path: "/categories", method: "GET", session: sessions[0] })).status).toBe(
    503
  );
});

it("rechecks revoke/use races at protected canonical work, not only bearer admission", async () => {
  const { db, send, sessions } = await setup();
  const issuedResponse = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      grant: {
        recipientLabel: "Race reader",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      },
    },
  });
  expect(issuedResponse.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await issuedResponse.json()
  ).data;
  const [inFlight, revocation] = await Promise.all([
    send({ path: "/transactions", method: "GET", bearer: issued.bearer }),
    send({ path: `/pats/${issued.pat.shortId}`, method: "DELETE", session: sessions[0] }),
  ]);
  expect([200, 401]).toContain(inFlight.status);
  expect(revocation.status).toBe(200);
  const before = await db
    .prepare(`SELECT count(*) AS total FROM pat_audit
    WHERE pat_id = (SELECT id FROM pats WHERE short_id = ?) AND operation = 'transactions.listTransactions'`)
    .bind(issued.pat.shortId)
    .first();
  const afterRevocation = await send({
    path: "/transactions",
    method: "GET",
    bearer: issued.bearer,
  });
  expect(afterRevocation.status).toBe(401);
  expect(
    (
      await db
        .prepare(`SELECT count(*) AS total FROM pat_audit
    WHERE pat_id = (SELECT id FROM pats WHERE short_id = ?) AND operation = 'transactions.listTransactions'`)
        .bind(issued.pat.shortId)
        .first()
    )?.total
  ).toBe(before?.total);
});

it("closes an approved unclaimed pairing on User revocation and prevents later claim", async () => {
  const { db, send, sessions } = await setup();
  const started = Schema.decodeUnknownSync(Started)(
    await (
      await send({
        path: "/pat-pairings",
        method: "POST",
        payload: { recipientLabel: "Agent", scopes: ["dashboard"], lifetimeDays: 365 },
      })
    ).json()
  );
  const inspected = Schema.decodeUnknownSync(Review)(
    await (
      await send({
        path: "/pats/pairings/inspect",
        method: "POST",
        session: sessions[0],
        payload: { publicCode: started.publicCode },
      })
    ).json()
  ).data;
  expect(
    (
      await send({
        path: "/pats/pairings/approve",
        method: "POST",
        session: sessions[0],
        payload: { pairingId: inspected.pairingId },
      })
    ).status
  ).toBe(200);
  expect((await send({ path: "/pats", method: "DELETE", session: sessions[1] })).status).toBe(200);
  const revoked = await send({ path: "/pats", method: "DELETE", session: sessions[0] });
  expect(revoked.status).toBe(200);
  expect(
    (
      await send({
        path: "/pat-pairings/claim",
        method: "POST",
        payload: {
          pairingId: started.pairingId,
          privateDeviceCode: started.privateDeviceCode,
        },
      })
    ).status
  ).toBe(400);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
        .bind(started.pairingId)
        .first()
    )?.total
  ).toBe(0);
});
