// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";

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
    patExpiresAt: Schema.String,
    scopes: Schema.Array(Schema.String),
    lifetimeDays: Schema.Number,
  }),
});
const Issued = Schema.Struct({
  pat: Schema.Struct({ shortId: Schema.String, expiresAt: Schema.String }),
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
    "0003_pending_consent",
    "0004_onboarding_email",
    "0005_verified_onboarding",
    "0006_browser_login",
    "0007_browser_pairing_email",
    "0008_support_recovery",
    "0009_pats",
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
        fetch: (incoming) =>
          coreWorker.fetch(new Request(incoming), {
            DB: db,
            AI: { run: () => Promise.reject(new Error("unused")) },
            CONTRACT_DIGEST: "a".repeat(64),
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            KAPSO_API_KEY: "",
            KAPSO_WEBHOOK_SECRET: "unused",
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
            CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
            CLOUDFLARE_ACCESS_AUDIENCE: "test",
          }),
      },
    });
  };
  return { db, send, sessions };
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
    payload: { pairingId: review.pairingId, patExpiresAt: review.patExpiresAt },
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
  const approval = await send({
    path: "/pats/pairings/approve",
    method: "POST",
    payload: { pairingId: review.pairingId, patExpiresAt: review.patExpiresAt },
    session: sessions[0],
  });
  expect(approval.status).toBe(200);
  const proof = { pairingId: created.pairingId, privateDeviceCode: created.privateDeviceCode };
  const claim = await send({ path: "/pat-pairings/claim", method: "POST", payload: proof });
  expect(claim.status).toBe(200);
  const issued = Schema.decodeUnknownSync(Issued)(await claim.json());
  expect(issued.bearer).toMatch(/^fin_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/u);
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
        payload: { pairingId: review.pairingId, patExpiresAt: review.patExpiresAt },
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
    grant: { recipientLabel: "My reader", scopes: ["read"], lifetimeDays: 7 },
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
    (await send({ path: `/pats/${issued.pat.shortId}`, method: "DELETE", session: sessions[0] }))
      .status
  ).toBe(200);
  const writer = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      grant: { recipientLabel: "Writer", scopes: ["write"], lifetimeDays: 30 },
    },
  });
  expect(writer.status).toBe(200);
  const writerBearer = Schema.decodeUnknownSync(Schema.Struct({ data: Issued }))(
    await writer.json()
  ).data.bearer;
  expect((await send({ path: "/categories", method: "GET", bearer: writerBearer })).status).toBe(
    401
  );
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
  const response = await send({
    path: "/pats",
    method: "POST",
    session: sessions[0],
    payload: {
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      grant: { recipientLabel: "Reader", scopes: ["read"], lifetimeDays: 7 },
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
        payload: { pairingId: inspected.pairingId, patExpiresAt: inspected.patExpiresAt },
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
