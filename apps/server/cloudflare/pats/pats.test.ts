import { Miniflare } from "miniflare";
import * as D1Client from "@effect/sql-d1/D1Client";
import { listCategoriesResponse } from "@fidy/server/categories";
import { Clock, Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it, vi } from "vitest";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";

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
    lifetimeDays: Schema.Finite,
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
// Tests cross real Miniflare, D1, and Worker Promise boundaries; keep their rejections in Effect.
class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{ cause: unknown }> {}
const awaitPromise = <A>(
  promise: PromiseLike<A> | A
): Effect.Effect<Awaited<A>, TestPromiseFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise),
    catch: (cause) => new TestPromiseFailure({ cause }),
  });
const runTest = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(work);
const clock = (): number => Effect.runSync(Clock.currentTimeMillis);
type ManualGrant = Readonly<{
  recipientLabel: string;
  scopes: ReadonlyArray<string>;
  lifetimeDays: number;
  reviewExpiresAt: string;
}>;
const manualGrant = (overrides: Partial<ManualGrant> = {}): ManualGrant => ({
  recipientLabel: "Agent",
  scopes: ["read"],
  lifetimeDays: 7,
  reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
  ...overrides,
});
type Send = Readonly<{
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
}> &
  Partial<
    Readonly<{
      payload: object;
      session: string;
      bearer: string;
      origin: string;
      source: string;
    }>
  >;
const setup = (
  beforeCoordinate?: (db: D1Database) => Promise<void>
): Promise<{
  db: D1Database;
  send: (input: Send) => Promise<Response>;
  sessions: readonly [string, string];
  scheduled: () => Promise<void>;
}> =>
  runTest(
    Effect.gen(function* () {
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: {
                DB: {
                  id: "pats",
                  type: "d1",
                },
              },
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
      yield* awaitPromise(mf.ready);
      const db = yield* awaitPromise(mf.getD1Database("DB"));
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
        "0009_transactions",
        "0010_pat_lifecycle",
        "0011_transaction_corrections",
        "0012_statement_staging",
        "0012_transaction_search",
        "0013_category_keyword_rules",
        "0013_transaction_reconciliation",
        "0014_memory",
        "0015_statement_submission",
        "0016_budgets",
        "0016_hosted_turn",
      ];
      for (const name of migrationNames) {
        const sql = yield* awaitPromise(
          Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text()
        );
        for (const statement of sql
          .replace(/^--.*$/gmu, "")
          .trim()
          .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)) {
          yield* awaitPromise(db.prepare(statement).run());
        }
      }
      const createSession = (user: string, index: number): Promise<string> =>
        runTest(
          Effect.gen(function* () {
            const current = clock();
            const token = String(index).repeat(43);
            const pairing = `30000000-0000-4000-8000-00000000000${index}`;
            const session = `40000000-0000-4000-8000-00000000000${index}`;
            yield* awaitPromise(
              db
                .prepare(
                  "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
                )
                .bind(user, current)
                .run()
            );
            yield* awaitPromise(
              db
                .prepare(`INSERT INTO browser_login_pairings (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms)
      VALUES (?,?,?,?,'consumed',?,?)`)
                .bind(
                  pairing,
                  `BCDF-GHJ${index}`,
                  yield* awaitPromise(dig(token)),
                  user,
                  current - 1_000,
                  current + 599_000
                )
                .run()
            );
            yield* awaitPromise(
              db
                .prepare(`INSERT INTO web_sessions (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`)
                .bind(
                  session,
                  pairing,
                  user,
                  yield* awaitPromise(dig(token)),
                  current,
                  current + 600_000,
                  current + 2_592_000_000,
                  current + 7_776_000_000
                )
                .run()
            );
            return `__Host-fidy_session=${token}`;
          })
        );
      const sessions = [
        yield* awaitPromise(createSession(userA, 1)),
        yield* awaitPromise(createSession(userB, 2)),
      ] as const;
      const coordinators = new Map<string, UserTransactionCoordinator>();
      const coreEnvironment = {
        DB: db,
        USER_TRANSACTION_COORDINATOR: {
          getByName: (name: string): Pick<Fetcher, "fetch"> => {
            let coordinator = coordinators.get(name);
            if (coordinator === undefined) {
              coordinator = new UserTransactionCoordinator(
                {
                  id: {
                    name,
                  },
                  storage: { setAlarm: (): Promise<void> => Promise.resolve() },
                },
                {
                  DB: db,
                  AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
                  HOSTED_AI_MODEL: approvedWorkersAiModel,
                }
              );
              coordinators.set(name, coordinator);
            }
            return {
              fetch: (input) =>
                runTest(
                  Effect.gen(function* () {
                    if (beforeCoordinate !== undefined) yield* awaitPromise(beforeCoordinate(db));
                    return yield* awaitPromise(coordinator.fetch(new Request(input)));
                  })
                ),
            };
          },
        },
        AI: {
          run: (): Promise<never> => Promise.reject(new Error("unused")),
        },
        CONTRACT_DIGEST: "a".repeat(64),
        RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
        HOSTED_AI_MODEL: approvedWorkersAiModel,
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        WOMPI_ENVIRONMENT: "",
        WOMPI_PUBLIC_KEY: "",
        WOMPI_PRIVATE_KEY: "",
        WOMPI_INTEGRITY_SECRET: "",
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
        const headers = new Headers({
          origin,
          "cf-connecting-ip": source,
        });
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
      return {
        db,
        send,
        sessions,
        scheduled,
      };
    })
  );
const issueManualPAT = ({
  send,
  session,
  requestId,
  grant,
}: Readonly<{
  send: (input: Send) => Promise<Response>;
  session: string;
  requestId: string;
  grant: ManualGrant;
}>): Effect.Effect<typeof Issued.Type, TestPromiseFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const response = yield* awaitPromise(
      send({ path: "/pats", method: "POST", session, payload: { requestId, grant } })
    );
    expect(response.status).toBe(200);
    return (yield* Schema.decodeUnknownEffect(Schema.Struct({ data: Issued }))(
      yield* awaitPromise(response.json())
    )).data;
  });
afterEach(() =>
  runTest(
    Effect.gen(function* () {
      vi.useRealTimers();
      yield* awaitPromise(Promise.all(instances.splice(0).map((mf) => mf.dispose())));
    })
  )
);
it("releases one scoped bearer to the private-code holder after web approval, never on replay", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const start = yield* awaitPromise(
        send({
          path: "/pat-pairings",
          method: "POST",
          payload: {
            recipientLabel: "My agent",
            scopes: ["read"],
            lifetimeDays: 7,
          },
        })
      );
      expect(start.status).toBe(200);
      const created = yield* Schema.decodeUnknownEffect(Started)(yield* awaitPromise(start.json()));
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: {
              pairingId: created.pairingId,
              privateDeviceCode: "x".repeat(43),
            },
          })
        )).status
      ).toBe(400);
      const reviewResponse = yield* awaitPromise(
        send({
          path: "/pats/pairings/inspect",
          method: "POST",
          payload: {
            publicCode: created.publicCode,
          },
          session: sessions[0],
        })
      );
      expect(reviewResponse.status).toBe(200);
      const review = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(reviewResponse.json())
      )).data;
      expect(review).toMatchObject({
        scopes: ["read"],
        lifetimeDays: 7,
      });
      const rejectedOrigin = yield* awaitPromise(
        send({
          path: "/pats/pairings/approve",
          method: "POST",
          payload: {
            pairingId: review.pairingId,
          },
          session: sessions[0],
          origin: "https://evil.example",
        })
      );
      expect(rejectedOrigin.status).toBe(403);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(review.pairingId).first()
        ))?.state
      ).toBe("pending_approval");
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first()
        ))?.total
      ).toBe(0);
      vi.useFakeTimers({
        toFake: ["Date"],
      });
      vi.setSystemTime(clock() + 240_000);
      const approval = yield* awaitPromise(
        send({
          path: "/pats/pairings/approve",
          method: "POST",
          payload: {
            pairingId: review.pairingId,
          },
          session: sessions[0],
        })
      );
      expect(approval.status).toBe(200);
      const proof = {
        pairingId: created.pairingId,
        privateDeviceCode: created.privateDeviceCode,
      };
      const claim = yield* awaitPromise(
        send({
          path: "/pat-pairings/claim",
          method: "POST",
          payload: proof,
        })
      );
      expect(claim.status).toBe(200);
      const issued = yield* Schema.decodeUnknownEffect(Issued)(yield* awaitPromise(claim.json()));
      expect(issued.bearer).toMatch(/^fin_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/u);
      expect(Date.parse(issued.pat.expiresAt) - Date.parse(issued.pat.createdAt)).toBe(
        7 * 86_400_000
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: proof,
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
            .bind(created.pairingId)
            .first()
        ))?.total
      ).toBe(1);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT bearer_digest FROM pats WHERE pairing_id = ?")
            .bind(created.pairingId)
            .first()
        ))?.bearer_digest
      ).not.toBe(issued.bearer);
    })
  ));
it("refuses a source's PAT pairing burst without denying an unrelated client", () =>
  runTest(
    Effect.gen(function* () {
      const { send } = yield* awaitPromise(setup());
      const attempt = (source: string): Promise<Response> =>
        send({
          path: "/pat-pairings",
          method: "POST",
          source,
          payload: {
            recipientLabel: "Desktop agent",
            scopes: ["read"],
          },
        });
      const admitted = yield* awaitPromise(
        Promise.all(
          Array.from(
            {
              length: 20,
            },
            () => attempt("198.51.100.10")
          )
        )
      );
      expect(admitted.map((result) => result.status)).toEqual(
        Array.from(
          {
            length: 20,
          },
          () => 200
        )
      );
      expect((yield* awaitPromise(attempt("198.51.100.10"))).status).toBe(429);
      expect((yield* awaitPromise(attempt("203.0.113.20"))).status).toBe(200);
    })
  ));
it("sweeps expired anonymous pairing metadata but preserves approved grant evidence", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, scheduled, sessions } = yield* awaitPromise(setup());
      const grant = {
        recipientLabel: "Desktop agent",
        scopes: ["read"],
        lifetimeDays: 7,
      };
      const pending = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: grant,
            })
          )).json()
        )
      );
      const approved = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: grant,
            })
          )).json()
        )
      );
      const review = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pats/pairings/inspect",
              method: "POST",
              session: sessions[0],
              payload: {
                publicCode: approved.publicCode,
              },
            })
          )).json()
        )
      )).data;
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: review.pairingId,
            },
          })
        )).status
      ).toBe(200);
      vi.useFakeTimers({
        toFake: ["Date"],
      });
      vi.setSystemTime(clock() + 600_001);
      yield* awaitPromise(scheduled());
      expect(
        yield* awaitPromise(
          db.prepare("SELECT 1 FROM pat_pairings WHERE id = ?").bind(pending.pairingId).first()
        )
      ).toBeNull();
      expect(
        yield* awaitPromise(
          db.prepare("SELECT 1 FROM pat_pairings WHERE id = ?").bind(approved.pairingId).first()
        )
      ).not.toBeNull();
      expect(
        yield* awaitPromise(
          db
            .prepare("SELECT 1 FROM pat_grant_consents WHERE pairing_id = ?")
            .bind(approved.pairingId)
            .first()
        )
      ).not.toBeNull();
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(approved.pairingId).first()
        ))?.state
      ).toBe("revoked_unclaimed");
      expect(
        yield* awaitPromise(
          db
            .prepare(
              "SELECT policy_reason,session_id FROM pat_revocation_consents WHERE pairing_id = ?"
            )
            .bind(approved.pairingId)
            .first()
        )
      ).toMatchObject({
        policy_reason: "pat-approved-unclaimed-expiry",
        session_id: null,
      });
      yield* awaitPromise(scheduled());
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pat_revocation_consents WHERE pairing_id = ?")
            .bind(approved.pairingId)
            .first()
        ))?.total
      ).toBe(1);
    })
  ));
it("atomically revokes claimable approvals with User-origin Consent evidence and blocks late claims", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const started = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: {
                recipientLabel: "Agent",
                scopes: ["read"],
              },
            })
          )).json()
        )
      );
      const review = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pats/pairings/inspect",
              method: "POST",
              session: sessions[0],
              payload: {
                publicCode: started.publicCode,
              },
            })
          )).json()
        )
      )).data;
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: review.pairingId,
            },
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "DELETE",
            session: sessions[1],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(started.pairingId).first()
        ))?.state
      ).toBe("approved_awaiting_claim");
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER test_revoke_all_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(503);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(started.pairingId).first()
        ))?.state
      ).toBe("approved_awaiting_claim");
      yield* awaitPromise(db.prepare("DROP TRIGGER test_revoke_all_failure").run());
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        yield* awaitPromise(
          db
            .prepare(
              "SELECT session_id,policy_reason FROM pat_revocation_consents WHERE pairing_id = ?"
            )
            .bind(started.pairingId)
            .first()
        )
      ).toMatchObject({
        session_id: "40000000-0000-4000-8000-000000000001",
        policy_reason: null,
      });
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first()
        ))?.total
      ).toBe(1);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: {
              pairingId: started.pairingId,
              privateDeviceCode: started.privateDeviceCode,
            },
          })
        )).status
      ).toBe(400);
    })
  ));
it("bounds per-User issuance even when every PAT is revoked immediately", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const grant = {
        recipientLabel: "Cycling client",
        scopes: ["read"],
        lifetimeDays: 7,
      };
      const manualGrant = {
        ...grant,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
      };
      yield* awaitPromise(
        Promise.all(
          Array.from(
            {
              length: 20,
            },
            (_, index) =>
              runTest(
                Effect.gen(function* () {
                  const response = yield* awaitPromise(
                    send({
                      path: "/pats",
                      method: "POST",
                      session: sessions[0],
                      payload: {
                        requestId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
                        grant: manualGrant,
                      },
                    })
                  );
                  expect(response.status).toBe(200);
                  expect(
                    (yield* awaitPromise(
                      send({
                        path: "/pats",
                        method: "DELETE",
                        session: sessions[0],
                      })
                    )).status
                  ).toBe(200);
                })
              )
          )
        )
      );
      const denied = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "00000000-0000-4000-8000-000000000020",
            grant: manualGrant,
          },
        })
      );
      expect(denied.status).toBe(429);
      expect(
        (yield* awaitPromise(db.prepare("SELECT count(*) AS total FROM pats").first()))?.total
      ).toBe(20);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first()
        ))?.total
      ).toBe(20);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first()
        ))?.total
      ).toBe(20);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE operation = 'pats.createManualPAT'"
            )
            .first()
        ))?.total
      ).toBe(20);
      const started = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: grant,
            })
          )).json()
        )
      );
      const review = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pats/pairings/inspect",
              method: "POST",
              session: sessions[0],
              payload: {
                publicCode: started.publicCode,
              },
            })
          )).json()
        )
      )).data;
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: review.pairingId,
            },
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: {
              pairingId: started.pairingId,
              privateDeviceCode: started.privateDeviceCode,
            },
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(db.prepare("SELECT count(*) AS total FROM pats").first()))?.total
      ).toBe(20);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(started.pairingId).first()
        ))?.state
      ).toBe("approved_awaiting_claim");
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "POST",
            session: sessions[1],
            payload: {
              requestId: "00000000-0000-4000-8000-000000000020",
              grant: manualGrant,
            },
          })
        )).status
      ).toBe(200);
    })
  ));
it("rolls back revoke-one and retries exactly one append-only Consent revocation after storage recovers", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const grant = manualGrant();
      const issued = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        grant,
      });
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER test_revoke_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
          .run()
      );
      const path = `/pats/${issued.pat.shortId}`;
      expect(
        (yield* awaitPromise(
          send({
            path,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(503);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.revoked_at_ms
      ).toBeNull();
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(200);
      yield* awaitPromise(db.prepare("DROP TRIGGER test_revoke_failure").run());
      expect(
        (yield* awaitPromise(
          send({
            path,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first()
        ))?.total
      ).toBe(1);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(401);
    })
  ));
it("atomically expires a fixed-lifetime PAT with policy-origin Consent evidence", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, scheduled, sessions } = yield* awaitPromise(setup());
      const original = clock();
      const issuedResponse = yield* awaitPromise(
        send({
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
        })
      );
      expect(issuedResponse.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(issuedResponse.json()))).data;
      vi.useFakeTimers({
        toFake: ["Date"],
      });
      vi.setSystemTime(Date.parse(issued.pat.expiresAt) + 1);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(401);
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER test_expiry_failure BEFORE INSERT ON pat_revocation_consents
    BEGIN SELECT RAISE(ABORT,'consent_unavailable'); END`)
          .run()
      );
      yield* awaitPromise(expect(scheduled()).rejects.toThrow());
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.revoked_at_ms
      ).toBeNull();
      yield* awaitPromise(db.prepare("DROP TRIGGER test_expiry_failure").run());
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER ignore_expiry_transition BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      yield* awaitPromise(expect(scheduled()).rejects.toThrow());
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
      yield* awaitPromise(db.prepare("DROP TRIGGER ignore_expiry_transition").run());
      yield* awaitPromise(scheduled());
      yield* awaitPromise(scheduled());
      expect(
        yield* awaitPromise(
          db
            .prepare(`SELECT r.policy_reason,r.session_id FROM pat_revocation_consents r
    JOIN pats p ON p.id = r.pat_id WHERE p.short_id = ?`)
            .bind(issued.pat.shortId)
            .first()
        )
      ).toMatchObject({
        policy_reason: "pat-fixed-lifetime-expiry",
        session_id: null,
      });
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first()
        ))?.total
      ).toBe(1);
    })
  ));
it("serializes concurrent private-code claims so only one bearer is ever issued", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const started = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: {
                recipientLabel: "Agent",
                scopes: ["read"],
              },
            })
          )).json()
        )
      );
      const review = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pats/pairings/inspect",
              method: "POST",
              payload: {
                publicCode: started.publicCode,
              },
              session: sessions[0],
            })
          )).json()
        )
      )).data;
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: review.pairingId,
            },
          })
        )).status
      ).toBe(200);
      const proof = {
        pairingId: started.pairingId,
        privateDeviceCode: started.privateDeviceCode,
      };
      const results = yield* awaitPromise(
        Promise.all([
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: proof,
          }),
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: proof,
          }),
        ])
      );
      expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
            .bind(started.pairingId)
            .first()
        ))?.total
      ).toBe(1);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pat_grant_consents WHERE pairing_id = ?")
            .bind(started.pairingId)
            .first()
        ))?.total
      ).toBe(1);
    })
  ));
it("isolates management by User and immediately refuses revoked and under-scoped PATs", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const payload = {
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        grant: {
          recipientLabel: "My reader",
          scopes: ["read"],
          lifetimeDays: 7,
          reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
        },
      };
      const stale = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            grant: {
              ...payload.grant,
              reviewExpiresAt: "2020-01-01T00:00:00.000Z",
            },
          },
        })
      );
      expect(stale.status).toBe(422);
      expect(yield* awaitPromise(stale.json())).toMatchObject({
        error: {
          code: "user_action_required",
        },
        next: [],
      });
      const issuedResponse = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          payload,
          session: sessions[0],
        })
      );
      expect(issuedResponse.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(issuedResponse.json()))).data;
      const replay = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          payload,
          session: sessions[0],
        })
      );
      expect(replay.status).toBe(409);
      expect(yield* awaitPromise(replay.json())).toMatchObject({
        error: {
          code: "user_action_required",
        },
        next: [],
      });
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[1],
          })
        )).status
      ).toBe(200);
      const ownedList = yield* awaitPromise(
        send({
          path: "/pats",
          method: "GET",
          session: sessions[0],
        })
      );
      expect(ownedList.status).toBe(200);
      const safeMetadata = yield* awaitPromise(ownedList.text());
      expect(safeMetadata).toContain(issued.pat.shortId);
      expect(safeMetadata).not.toContain(issued.bearer);
      const foreign = yield* awaitPromise(
        send({
          path: `/pats/${issued.pat.shortId}`,
          method: "DELETE",
          session: sessions[1],
        })
      );
      expect(foreign.status).toBe(404);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.revoked_at_ms
      ).toBeNull();
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).not.toBe(401);
      expect(
        (yield* awaitPromise(
          send({
            path: `/pats/${issued.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(401);
      expect(
        yield* awaitPromise(
          db
            .prepare(`SELECT r.session_id,r.policy_reason FROM pat_revocation_consents r
    JOIN pats p ON p.id = r.pat_id WHERE p.short_id = ?`)
            .bind(issued.pat.shortId)
            .first()
        )
      ).toMatchObject({
        session_id: "40000000-0000-4000-8000-000000000001",
        policy_reason: null,
      });
      expect(
        (yield* awaitPromise(
          send({
            path: `/pats/${issued.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_revocation_consents WHERE pat_id IS NOT NULL"
            )
            .first()
        ))?.total
      ).toBe(1);
      const writer = yield* awaitPromise(
        send({
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
        })
      );
      expect(writer.status).toBe(200);
      const writerBearer = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(writer.json()))).data.bearer;
      const underScoped = yield* awaitPromise(
        send({
          path: "/categories",
          method: "GET",
          bearer: writerBearer,
        })
      );
      expect(underScoped.status).toBe(403);
      expect(yield* awaitPromise(underScoped.json())).toMatchObject({
        error: {
          code: "scope_missing",
        },
        next: [],
      });
      const auditBeforeSearch = yield* awaitPromise(
        db.prepare("SELECT count(*) AS total FROM transaction_audit").first<{ total: number }>()
      );
      const deniedSearch = yield* awaitPromise(
        send({ path: "/transactions/search?q=private", method: "GET", bearer: writerBearer })
      );
      expect(deniedSearch.status).toBe(403);
      expect(yield* awaitPromise(deniedSearch.json())).toMatchObject({
        error: { code: "scope_missing" },
        next: [],
      });
      expect(
        yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM transaction_audit").first<{ total: number }>()
        )
      ).toEqual(auditBeforeSearch);
      yield* awaitPromise(
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE bearer_digest = ?")
          .bind(clock(), yield* awaitPromise(dig(writerBearer)))
          .run()
      );
      const revokedWriter = yield* awaitPromise(
        send({
          path: "/categories",
          method: "GET",
          bearer: writerBearer,
        })
      );
      expect(revokedWriter.status).toBe(401);
      expect(yield* awaitPromise(revokedWriter.json())).toMatchObject({
        error: {
          code: "unauthenticated",
        },
      });
    })
  ));
it("mints manual PATs for the complete selected lifetime from issuance", () =>
  runTest(
    Effect.gen(function* () {
      const { send, sessions } = yield* awaitPromise(setup());
      const current = clock();
      const grant = {
        recipientLabel: "Reviewed agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 7 * 86_400_000)),
      };
      vi.useFakeTimers({
        toFake: ["Date"],
      });
      vi.setSystemTime(current + 120_000);
      const issuedResponse = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            grant,
          },
        })
      );
      expect(issuedResponse.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(issuedResponse.json()))).data;
      expect(Date.parse(issued.pat.expiresAt) - Date.parse(issued.pat.createdAt)).toBe(
        7 * 86_400_000
      );
    })
  ));
it("does not leave revoke-all Consent evidence when the PAT transition is refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issued = yield* awaitPromise(
        send({
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
        })
      );
      expect(issued.status).toBe(200);
      const token = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(issued.json()))).data;
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_all_revocations BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const revoked = yield* awaitPromise(
        send({
          path: "/pats",
          method: "DELETE",
          session: sessions[0],
        })
      );
      expect(revoked.status).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: token.bearer,
          })
        )).status
      ).toBe(200);
    })
  ));
it("does not append revocation Consent when the PAT transition silently fails", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const token = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "70000000-0000-4000-8000-000000000051",
        grant: manualGrant(),
      });
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_pat_revocation BEFORE UPDATE OF revoked_at_ms ON pats
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const revoked = yield* awaitPromise(
        send({
          path: `/pats/${token.pat.shortId}`,
          method: "DELETE",
          session: sessions[0],
        })
      );
      expect(revoked.status).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_revocation_consents").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: token.bearer,
          })
        )).status
      ).toBe(200);
    })
  ));
it("retries a claim without losing its approval when the claim AuditLogEntry is refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const started = yield* awaitPromise(
        send({
          path: "/pat-pairings",
          method: "POST",
          payload: {
            recipientLabel: "Agent",
            scopes: ["read"],
            lifetimeDays: 7,
          },
        })
      );
      expect(started.status).toBe(200);
      const pairing = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(started.json())
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/inspect",
            method: "POST",
            session: sessions[0],
            payload: {
              publicCode: pairing.publicCode,
            },
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: pairing.pairingId,
            },
          })
        )).status
      ).toBe(200);
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_claim_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'pats.claim' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const proof = {
        pairingId: pairing.pairingId,
        privateDeviceCode: pairing.privateDeviceCode,
      };
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: proof,
          })
        )).status
      ).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(pairing.pairingId).first<{
            state: string;
          }>()
        ))?.state
      ).toBe("approved_awaiting_claim");
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pats").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
      yield* awaitPromise(db.prepare("DROP TRIGGER refuse_claim_audit").run());
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: proof,
          })
        )).status
      ).toBe(200);
    })
  ));
it("keeps a PATPairing pending when its approval ConsentRecord is silently refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const started = yield* awaitPromise(
        send({
          path: "/pat-pairings",
          method: "POST",
          payload: {
            recipientLabel: "Agent",
            scopes: ["read"],
            lifetimeDays: 7,
          },
        })
      );
      expect(started.status).toBe(200);
      const pairing = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(started.json())
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/inspect",
            method: "POST",
            session: sessions[0],
            payload: {
              publicCode: pairing.publicCode,
            },
          })
        )).status
      ).toBe(200);
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_pairing_grant BEFORE INSERT ON pat_grant_consents
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const approval = yield* awaitPromise(
        send({
          path: "/pats/pairings/approve",
          method: "POST",
          session: sessions[0],
          payload: {
            pairingId: pairing.pairingId,
          },
        })
      );
      expect(approval.status).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT state FROM pat_pairings WHERE id = ?").bind(pairing.pairingId).first<{
            state: string;
          }>()
        ))?.state
      ).toBe("pending_approval");
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
    })
  ));
it("does not commit a PAT when its ConsentRecord is silently refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_pat_grant BEFORE INSERT ON pat_grant_consents
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const response = yield* awaitPromise(
        send({
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
        })
      );
      expect(response.status).not.toBe(200);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(response.json())
        )
      ).not.toContain("fin_");
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pats").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM pat_grant_consents").first<{
            total: number;
          }>()
        ))?.total
      ).toBe(0);
    })
  ));
it("denies PAT metadata reads after explicit Consent withdrawal at protected work", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_list_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'pats.listPATs' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).not.toBe(200);
      yield* awaitPromise(db.prepare("DROP TRIGGER refuse_list_audit").run());
      const grantId = "e0000000-0000-4000-8000-000000000031";
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO onboarding_consent_records
    (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
    VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(grantId, userA, clock(), clock())
          .run()
      );
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO consent_user_revocations
    (id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES (?,?,?,?,?)`)
          .bind(
            "e0000000-0000-4000-8000-000000000032",
            userA,
            grantId,
            "40000000-0000-4000-8000-000000000001",
            clock()
          )
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pat_audit WHERE operation = 'pats.listPATs'")
            .first()
        ))?.total
      ).toBe(1);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[1],
          })
        )).status
      ).toBe(200);
    })
  ));
it("includes PAT metadata listing in the shared User/day canonical work budget", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 255)
    INSERT INTO transaction_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT lower(hex(randomblob(16))), ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(userA, "40000000-0000-4000-8000-000000000001", clock())
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(429);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[1],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(503);
    })
  ));
it("bounds canonical work across a stable User and multiple PATs", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issue = (requestId: string): Promise<typeof Issued.Type> =>
        runTest(
          Effect.gen(function* () {
            const result = yield* awaitPromise(
              send({
                path: "/pats",
                method: "POST",
                session: sessions[0],
                payload: {
                  requestId,
                  grant: {
                    recipientLabel: "Budgeted agent",
                    scopes: ["read"],
                    lifetimeDays: 7,
                    reviewExpiresAt: DateTime.formatIso(
                      DateTime.makeUnsafe(clock() + 7 * 86_400_000)
                    ),
                  },
                },
              })
            );
            expect(result.status).toBe(200);
            return (yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                data: Issued,
              })
            )(yield* awaitPromise(result.json()))).data;
          })
        );
      const first = yield* awaitPromise(issue("70000000-0000-4000-8000-000000000031"));
      const second = yield* awaitPromise(issue("70000000-0000-4000-8000-000000000032"));
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: first.bearer,
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: second.bearer,
          })
        )).status
      ).toBe(200);
      const pat = yield* awaitPromise(
        db.prepare("SELECT id FROM pats WHERE short_id = ?").bind(second.pat.shortId).first<{
          id: string;
        }>()
      );
      expect(pat).not.toBeNull();
      yield* awaitPromise(
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 254)
    INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT lower(hex(randomblob(16))), ?, ?, 'transactions.listTransactions', 'accepted', ? FROM seq`)
          .bind(userA, pat?.id, clock())
          .run()
      );
      const count = (yield* awaitPromise(
        db
          .prepare(
            "SELECT count(*) AS total FROM pat_audit WHERE user_id = ? AND operation = 'transactions.listTransactions'"
          )
          .bind(userA)
          .first<{
            total: number;
          }>()
      ))?.total;
      expect(count).toBe(256);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: first.bearer,
          })
        )).status
      ).toBe(429);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: second.bearer,
          })
        )).status
      ).toBe(429);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(429);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE user_id = ? AND operation = 'transactions.listTransactions'"
            )
            .bind(userA)
            .first<{
              total: number;
            }>()
        ))?.total
      ).toBe(count);
    })
  ));
it("returns user_action_required when Consent is withdrawn between PAT admission and protected Transaction work", () =>
  runTest(
    Effect.gen(function* () {
      let withdrawOnCapture = false;
      const grantId = "e0000000-0000-4000-8000-000000000041";
      const writerGrantId = "e0000000-0000-4000-8000-000000000043";
      let revocationSequence = 0;
      const revoke = (db: D1Database): Promise<D1Result> =>
        db
          .prepare(`INSERT INTO consent_user_revocations
      (id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES (?,?,?,?,?)`)
          .bind(
            `e0000000-0000-4000-8000-${String(++revocationSequence).padStart(12, "0")}`,
            userB,
            writerGrantId,
            "40000000-0000-4000-8000-000000000002",
            clock()
          )
          .run();
      const { db, send, sessions } = yield* awaitPromise(
        setup((database) =>
          runTest(
            Effect.gen(function* () {
              if (withdrawOnCapture) yield* awaitPromise(revoke(database));
            })
          )
        )
      );
      const issue = (
        scope: "read" | "write",
        requestId: string,
        session: string
      ): Promise<typeof Issued.Type> =>
        runTest(
          Effect.gen(function* () {
            const response = yield* awaitPromise(
              send({
                path: "/pats",
                method: "POST",
                session,
                payload: {
                  requestId,
                  grant: {
                    recipientLabel: "Consent race agent",
                    scopes: [scope],
                    lifetimeDays: 7,
                    reviewExpiresAt: DateTime.formatIso(
                      DateTime.makeUnsafe(clock() + 7 * 86_400_000)
                    ),
                  },
                },
              })
            );
            expect(response.status).toBe(200);
            return (yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                data: Issued,
              })
            )(yield* awaitPromise(response.json()))).data;
          })
        );
      const reader = yield* awaitPromise(
        issue("read", "70000000-0000-4000-8000-000000000044", sessions[0])
      );
      const writer = yield* awaitPromise(
        issue("write", "70000000-0000-4000-8000-000000000045", sessions[1])
      );
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO onboarding_consent_records
    (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
    VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(grantId, userA, clock(), clock())
          .run()
      );
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO onboarding_consent_records
    (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
    VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(writerGrantId, userB, clock(), clock())
          .run()
      );
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER withdraw_during_pat_read BEFORE UPDATE OF last_used_at_ms ON pats
    WHEN OLD.short_id = '${reader.pat.shortId}' BEGIN
    INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
    VALUES ('e0000000-0000-4000-8000-000000000042','${userA}','${grantId}',
      '40000000-0000-4000-8000-000000000001',${clock()}); END`)
          .run()
      );
      const history = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "GET",
          bearer: reader.bearer,
        })
      );
      expect(history.status).toBe(403);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(history.json())
        )
      ).toContain("user_action_required");
      yield* awaitPromise(db.prepare("DROP TRIGGER withdraw_during_pat_read").run());
      withdrawOnCapture = true;
      const capture = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "POST",
          bearer: writer.bearer,
          payload: {
            money: {
              amount: "23.50",
              currency: "COP",
            },
            direction: "outflow",
            occurredAt: "2026-09-01T12:00:00.000Z",
          },
        })
      );
      expect(capture.status).toBe(403);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(capture.json())
        )
      ).toContain("user_action_required");
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM transactions WHERE user_id = ?")
            .bind(userB)
            .first<{
              total: number;
            }>()
        ))?.total
      ).toBe(0);
    })
  ));
it("records successful PAT Transaction capture as use activity without extending its expiry", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issued = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "70000000-0000-4000-8000-000000000042",
        grant: manualGrant({ recipientLabel: "Capture agent", scopes: ["write"] }),
      });
      const Activity = Schema.Struct({
        last_used_at_ms: Schema.NullOr(Schema.Finite),
        expires_at_ms: Schema.Finite,
      });
      const before = yield* Schema.decodeUnknownEffect(Activity)(
        yield* awaitPromise(
          db
            .prepare("SELECT last_used_at_ms,expires_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        )
      );
      expect(before.last_used_at_ms).toBeNull();
      const captured = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "POST",
          bearer: issued.bearer,
          payload: {
            money: {
              amount: "23.50",
              currency: "COP",
            },
            direction: "outflow",
            occurredAt: "2026-09-01T12:00:00.000Z",
          },
        })
      );
      expect(captured.status).toBe(201);
      const after = yield* Schema.decodeUnknownEffect(Activity)(
        yield* awaitPromise(
          db
            .prepare("SELECT last_used_at_ms,expires_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        )
      );
      expect(after.last_used_at_ms).not.toBeNull();
      expect(after.expires_at_ms).toBe(before.expires_at_ms);
      const listed = yield* awaitPromise(
        send({
          path: "/pats",
          method: "GET",
          session: sessions[0],
        })
      );
      expect(listed.status).toBe(200);
      const Listed = Schema.Struct({
        data: Schema.Struct({
          pats: Schema.Array(
            Schema.Struct({
              shortId: Schema.String,
              lastUsedAt: Schema.NullOr(Schema.String),
            })
          ),
        }),
      });
      const pats = (yield* Schema.decodeUnknownEffect(Listed)(yield* awaitPromise(listed.json())))
        .data.pats;
      expect(pats.find((pat) => pat.shortId === issued.pat.shortId)?.lastUsedAt).not.toBeNull();
    })
  ));
it("rolls back PAT Transaction capture and activity when its audit is silently refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issued = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "70000000-0000-4000-8000-000000000043",
        grant: manualGrant({ recipientLabel: "Atomic capture agent", scopes: ["write"] }),
      });
      const capture = {
        money: {
          amount: "23.50",
          currency: "COP",
        },
        direction: "outflow",
        occurredAt: "2026-09-01T12:00:00.000Z",
      };
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_pat_capture_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'transactions.createTransaction' AND NEW.outcome = 'accepted'
    BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            bearer: issued.bearer,
            payload: capture,
          })
        )).status
      ).not.toBe(201);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM transactions WHERE user_id = ?")
            .bind(userA)
            .first<{
              total: number;
            }>()
        ))?.total
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.last_used_at_ms
      ).toBeNull();
      yield* awaitPromise(db.prepare("DROP TRIGGER refuse_pat_capture_audit").run());
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            bearer: issued.bearer,
            payload: capture,
          })
        )).status
      ).toBe(201);
    })
  ));
it("rechecks PAT scope after admission at the protected D1 read and audit", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const response = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "70000000-0000-4000-8000-000000000041",
            grant: {
              recipientLabel: "Scope race agent",
              scopes: ["read"],
              lifetimeDays: 7,
              reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
            },
          },
        })
      );
      expect(response.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(response.json()))).data;
      const changeScopeOnUse = `CREATE TRIGGER scope_changes_during_use BEFORE UPDATE OF last_used_at_ms ON pats
    WHEN OLD.scopes_json = '["read"]' BEGIN
    UPDATE pats SET scopes_json = '["dashboard"]' WHERE id = OLD.id; END`;
      yield* awaitPromise(db.prepare(changeScopeOnUse).run());
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE operation = 'categories.listCategories'"
            )
            .first()
        ))?.total
      ).toBe(0);
      yield* awaitPromise(
        db
          .prepare("UPDATE pats SET scopes_json = '[\"read\"]' WHERE short_id = ?")
          .bind(issued.pat.shortId)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE operation = 'transactions.listTransactions'"
            )
            .first()
        ))?.total
      ).toBe(0);
      yield* awaitPromise(db.prepare("DROP TRIGGER scope_changes_during_use").run());
      yield* awaitPromise(
        db
          .prepare("UPDATE pats SET scopes_json = '[\"read\"]' WHERE short_id = ?")
          .bind(issued.pat.shortId)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(200);
    })
  ));
it("gates every declared canonical path by live PAT and exact operation scope before any unavailable adapter", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issue = (
        scope: "read" | "write" | "dashboard",
        index: number
      ): Effect.Effect<typeof Issued.Type, TestPromiseFailure | Schema.SchemaError> =>
        issueManualPAT({
          send,
          session: sessions[0],
          requestId: `70000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          grant: manualGrant({ recipientLabel: `Agent ${index}`, scopes: [scope] }),
        });
      const reader = yield* issue("read", 1);
      const writer = yield* issue("write", 2);
      const dashboard = yield* issue("dashboard", 3);
      const capture = {
        money: {
          amount: "2300.50",
          currency: "COP",
        },
        direction: "outflow",
        categoryId: "10000000-0000-4000-8000-000000000001",
        occurredAt: "2026-09-01T12:00:00.000Z",
      };
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            bearer: reader.bearer,
            payload: capture,
          })
        )).status
      ).toBe(403);
      const created = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "POST",
          bearer: writer.bearer,
          payload: capture,
        })
      );
      expect(created.status).toBe(201);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            bearer: writer.bearer,
            payload: {},
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE operation = 'transactions.createTransaction' AND outcome = 'accepted'"
            )
            .first()
        ))?.total
      ).toBe(1);
      const transactionId = "90000000-0000-4000-8000-000000000001";
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at)
    VALUES (?,?,?,'COP','outflow',?,'2026-09-01T12:00:00.000Z','2026-09-01T12:00:00.000Z')`)
          .bind(transactionId, userA, "1000.00", "10000000-0000-4000-8000-000000000001")
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: `/transactions/${transactionId}`,
            method: "PUT",
            bearer: reader.bearer,
            payload: { expectedRevision: 0, changes: { direction: "inflow" } },
          })
        )).status
      ).toBe(403);
      expect(
        yield* awaitPromise(
          db
            .prepare("SELECT revision, direction FROM transactions WHERE id = ?")
            .bind(transactionId)
            .first<{ revision: number; direction: string }>()
        )
      ).toEqual({ revision: 0, direction: "outflow" });
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM transaction_corrections WHERE transaction_id = ?"
            )
            .bind(transactionId)
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM pat_audit WHERE operation = 'transactions.updateTransaction'"
            )
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: writer.bearer,
          })
        )).status
      ).toBe(403);
      const history = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "GET",
          bearer: reader.bearer,
        })
      );
      expect(history.status).toBe(200);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(history.json())
        )
      ).toContain(transactionId);
      expect(
        (yield* awaitPromise(
          send({
            path: `/transactions/${transactionId}`,
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(200);
      const foreignTransactionId = "90000000-0000-4000-8000-000000000002";
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at)
    VALUES (?,?,?,'COP','outflow',?,'2026-09-01T12:00:00.000Z','2026-09-01T12:00:00.000Z')`)
          .bind(foreignTransactionId, userB, "2000.00", "10000000-0000-4000-8000-000000000001")
          .run()
      );
      const isolated = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "GET",
          bearer: reader.bearer,
        })
      );
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(isolated.json())
        )
      ).not.toContain(foreignTransactionId);
      expect(
        (yield* awaitPromise(
          send({
            path: `/transactions/${foreignTransactionId}`,
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(404);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "POST",
            bearer: reader.bearer,
            payload: {},
          })
        )).status
      ).toBe(403);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "POST",
            bearer: writer.bearer,
            payload: {},
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          send({
            path: "/dashboard/edits",
            method: "POST",
            bearer: reader.bearer,
            payload: {},
          })
        )).status
      ).toBe(403);
      expect(
        (yield* awaitPromise(
          send({
            path: "/dashboard/edits",
            method: "POST",
            bearer: dashboard.bearer,
            payload: {},
          })
        )).status
      ).toBe(503);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions/foreign-id",
            method: "GET",
            bearer: writer.bearer,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions/foreign-id",
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(404);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "GET",
            bearer: "fin_invalid",
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "GET",
            bearer: reader.bearer,
            origin: "https://evil.example",
          })
        )).status
      ).toBe(403);
      expect(
        (yield* awaitPromise(
          send({
            path: `/pats/${reader.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          send({
            path: `/pats/${writer.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            bearer: writer.bearer,
            payload: capture,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          db
            .prepare(
              "SELECT count(*) AS total FROM pat_audit WHERE operation = 'budgets.listBudgets'"
            )
            .first()
        ))?.total
      ).toBe(1);
      const stillLive = yield* issue("read", 4);
      const grantId = "e0000000-0000-4000-8000-000000000001";
      yield* awaitPromise(
        db
          .prepare(`INSERT INTO onboarding_consent_records
    (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
    VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(grantId, userA, clock(), clock())
          .run()
      );
      const [withdrawal, concurrentUse] = yield* awaitPromise(
        Promise.all([
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
          send({
            path: "/transactions",
            method: "GET",
            bearer: stillLive.bearer,
          }),
        ])
      );
      expect(withdrawal.meta.changes).toBe(1);
      expect([200, 403]).toContain(concurrentUse.status);
      const withdrawn = yield* awaitPromise(
        send({
          path: "/categories",
          method: "GET",
          bearer: stillLive.bearer,
        })
      );
      expect(withdrawn.status).toBe(403);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(withdrawn.json())
        )
      ).toContain("user_action_required");
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            bearer: stillLive.bearer,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: "fin_invalid",
          })
        )).status
      ).toBe(401);
      const rejectedIssuance = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "70000000-0000-4000-8000-000000000005",
            grant: manualGrant({ recipientLabel: "Too late" }),
          },
        })
      );
      expect(rejectedIssuance.status).toBe(403);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* awaitPromise(rejectedIssuance.json())
        )
      ).toContain("user_action_required");
      const pairingStart = yield* awaitPromise(
        send({
          path: "/pat-pairings",
          method: "POST",
          payload: {
            recipientLabel: "Post-consent client",
            scopes: ["read"],
            lifetimeDays: 7,
          },
        })
      );
      expect(pairingStart.status).toBe(200);
      const pending = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(pairingStart.json())
      );
      const deniedApproval = yield* awaitPromise(
        send({
          path: "/pats/pairings/approve",
          method: "POST",
          session: sessions[0],
          payload: {
            pairingId: pending.pairingId,
          },
        })
      );
      expect(deniedApproval.status).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pat_grant_consents WHERE pairing_id = ?")
            .bind(pending.pairingId)
            .first()
        ))?.total
      ).toBe(0);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          send({
            path: "/transactions",
            method: "POST",
            session: sessions[0],
            payload: capture,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          db.prepare("SELECT count(*) AS total FROM source_attestations").first()
        ))?.total
      ).toBe(1);
    })
  ));
it("rejects invalid grants, expired bearers and stale browser authority without partial effects", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const invalid = yield* awaitPromise(
        send({
          path: "/pat-pairings",
          method: "POST",
          payload: {
            recipientLabel: "Nobody",
            scopes: [],
          },
        })
      );
      expect(invalid.status).toBe(400);
      expect(
        (yield* awaitPromise(db.prepare("SELECT count(*) AS total FROM pat_pairings").first()))
          ?.total
      ).toBe(0);
      const unreviewed = yield* awaitPromise(
        send({
          path: "/pats",
          method: "POST",
          session: sessions[0],
          payload: {
            requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            grant: {
              recipientLabel: "No review",
              scopes: ["read"],
              lifetimeDays: 7,
            },
          },
        })
      );
      expect(unreviewed.status).toBe(400);
      expect(
        (yield* awaitPromise(db.prepare("SELECT count(*) AS total FROM pats").first()))?.total
      ).toBe(0);
      const response = yield* awaitPromise(
        send({
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
        })
      );
      expect(response.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(response.json()))).data;
      const expired = yield* awaitPromise(
        db
          .prepare(
            "UPDATE pats SET created_at_ms = created_at_ms - 691200000, expires_at_ms = expires_at_ms - 691200000 WHERE short_id = ?"
          )
          .bind(issued.pat.shortId)
          .run()
      );
      expect(expired.meta.changes).toBe(1);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.last_used_at_ms
      ).toBeNull();
      vi.useFakeTimers({
        toFake: ["Date"],
      });
      vi.setSystemTime(clock() + 601_000);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: `/pats/${issued.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(401);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT revoked_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.revoked_at_ms
      ).toBeNull();
    })
  ));
it("shares one Category projection and row codec between HTTP and the hosted-agent query", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const http = yield* awaitPromise(
        send({
          path: "/categories",
          method: "GET",
          session: sessions[0],
        })
      );
      expect(http.status).toBe(200);
      const fromAgent = yield* Effect.scoped(
        Effect.gen(function* () {
          const clients = yield* Layer.build(
            D1Client.layer({
              db,
            })
          );
          return yield* listCategoriesResponse.pipe(
            Effect.withTracerEnabled(false),
            Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient))
          );
        })
      );
      expect(yield* awaitPromise(http.json())).toEqual(fromAgent);
    })
  ));
it("fails closed with declared unavailable for an authenticated WebSession whose canonical adapter is absent", () =>
  runTest(
    Effect.gen(function* () {
      const { send, sessions } = yield* awaitPromise(setup());
      const authenticated = yield* awaitPromise(
        send({
          path: "/dashboard/edits",
          method: "POST",
          payload: {},
          session: sessions[0],
        })
      );
      expect(authenticated.status).toBe(503);
      expect(yield* awaitPromise(authenticated.json())).toMatchObject({
        error: {
          code: "unavailable",
        },
      });
      expect(
        (yield* awaitPromise(
          send({
            path: "/budgets",
            method: "GET",
            session: "__Host-fidy_session=invalid",
          })
        )).status
      ).toBe(401);
    })
  ));
it("does not commit PAT activity or disclose Category rows when its audit is silently refused", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issued = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "f0000000-0000-4000-8000-000000000002",
        grant: manualGrant({ recipientLabel: "Audited reader" }),
      });
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER ignore_category_audit BEFORE INSERT ON pat_audit
    WHEN NEW.operation = 'categories.listCategories' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).not.toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
            .bind(issued.pat.shortId)
            .first()
        ))?.last_used_at_ms
      ).toBeNull();
      yield* awaitPromise(db.prepare("DROP TRIGGER ignore_category_audit").run());
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          db
            .prepare(`SELECT count(*) AS total FROM pat_audit WHERE operation = 'categories.listCategories'
    AND pat_id = (SELECT id FROM pats WHERE short_id = ?)`)
            .bind(issued.pat.shortId)
            .first()
        ))?.total
      ).toBe(1);
    })
  ));
it("shares the Category work budget between WebSessions, PATs and Transaction work", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issued = yield* issueManualPAT({
        send,
        session: sessions[0],
        requestId: "f0000000-0000-4000-8000-000000000001",
        grant: manualGrant({ recipientLabel: "Category reader" }),
      });
      yield* awaitPromise(
        db.batch(
          Array.from(
            {
              length: 255,
            },
            (_, index) =>
              db
                .prepare(`INSERT INTO transaction_audit
    (id,user_id,session_id,operation,outcome,occurred_at_ms)
    VALUES (?, ?, ?, 'transactions.listTransactions', 'success', ?)`)
                .bind(
                  `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                  userA,
                  "40000000-0000-4000-8000-000000000001",
                  clock()
                )
          )
        )
      );
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            bearer: issued.bearer,
          })
        )).status
      ).toBe(503);
      expect(
        (yield* awaitPromise(
          send({
            path: "/categories",
            method: "GET",
            session: sessions[0],
          })
        )).status
      ).toBe(503);
    })
  ));
it("rechecks revoke/use races at protected canonical work, not only bearer admission", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const issuedResponse = yield* awaitPromise(
        send({
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
        })
      );
      expect(issuedResponse.status).toBe(200);
      const issued = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Issued,
        })
      )(yield* awaitPromise(issuedResponse.json()))).data;
      const [inFlight, revocation] = yield* awaitPromise(
        Promise.all([
          send({
            path: "/transactions",
            method: "GET",
            bearer: issued.bearer,
          }),
          send({
            path: `/pats/${issued.pat.shortId}`,
            method: "DELETE",
            session: sessions[0],
          }),
        ])
      );
      expect([200, 401]).toContain(inFlight.status);
      expect(revocation.status).toBe(200);
      const before = yield* awaitPromise(
        db
          .prepare(`SELECT count(*) AS total FROM pat_audit
    WHERE pat_id = (SELECT id FROM pats WHERE short_id = ?) AND operation = 'transactions.listTransactions'`)
          .bind(issued.pat.shortId)
          .first()
      );
      const afterRevocation = yield* awaitPromise(
        send({
          path: "/transactions",
          method: "GET",
          bearer: issued.bearer,
        })
      );
      expect(afterRevocation.status).toBe(401);
      expect(
        (yield* awaitPromise(
          db
            .prepare(`SELECT count(*) AS total FROM pat_audit
    WHERE pat_id = (SELECT id FROM pats WHERE short_id = ?) AND operation = 'transactions.listTransactions'`)
            .bind(issued.pat.shortId)
            .first()
        ))?.total
      ).toBe(before?.total);
    })
  ));
it("closes an approved unclaimed pairing on User revocation and prevents later claim", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const started = yield* Schema.decodeUnknownEffect(Started)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pat-pairings",
              method: "POST",
              payload: {
                recipientLabel: "Agent",
                scopes: ["dashboard"],
                lifetimeDays: 365,
              },
            })
          )).json()
        )
      );
      const inspected = (yield* Schema.decodeUnknownEffect(Review)(
        yield* awaitPromise(
          (yield* awaitPromise(
            send({
              path: "/pats/pairings/inspect",
              method: "POST",
              session: sessions[0],
              payload: {
                publicCode: started.publicCode,
              },
            })
          )).json()
        )
      )).data;
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats/pairings/approve",
            method: "POST",
            session: sessions[0],
            payload: {
              pairingId: inspected.pairingId,
            },
          })
        )).status
      ).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pats",
            method: "DELETE",
            session: sessions[1],
          })
        )).status
      ).toBe(200);
      const revoked = yield* awaitPromise(
        send({
          path: "/pats",
          method: "DELETE",
          session: sessions[0],
        })
      );
      expect(revoked.status).toBe(200);
      expect(
        (yield* awaitPromise(
          send({
            path: "/pat-pairings/claim",
            method: "POST",
            payload: {
              pairingId: started.pairingId,
              privateDeviceCode: started.privateDeviceCode,
            },
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          db
            .prepare("SELECT count(*) AS total FROM pats WHERE pairing_id = ?")
            .bind(started.pairingId)
            .first()
        ))?.total
      ).toBe(0);
    })
  ));
