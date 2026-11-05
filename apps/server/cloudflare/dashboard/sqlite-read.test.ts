import { makeAgentService } from "../agent/runtime";
import { openAiTestKey } from "../openai.test-fixture";
import { approvedOpenAiModel } from "../../src/shell/hosted-inference/contract";
import { UserId } from "../../src/core/identity/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { HostedDashboardAdmission } from "../agent/contract";
import { makeMcpResidency } from "../mcp/runtime";
import { OAuthMcpAdmission } from "../mcp/contract";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import type { CoreHttpBindings } from "../core-http/contract";
import { makeCoreHttp } from "../core-http/runtime";
import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import { NativeDashboardResult } from "./contract";
import { freeAllowanceLimits } from "../../src/core/quotas/contract";
import { allowancePeriod } from "../../src/core/quotas/operations";
import { it } from "@effect/vitest";
import { type Cause, Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { sqliteTestStorage } from "../sqlite-store/test-database.test-fixture";
import { installTestSchema } from "../d1-test-fixture";
import { browserSessionBindingHeader } from "../../src/shell/browser-transport/contract";

const storage = sqliteTestStorage();
afterAll(() => storage.dispose());
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "60000000-0000-4000-8000-000000000001";
const io = <A>(work: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(work);
const setupOn = (
  acquire: () => ReturnType<typeof storage.acquire>
): ReturnType<typeof setupEffect> => setupEffect(acquire);
const setupEffect = (
  acquire: () => ReturnType<typeof storage.acquire>
): Effect.Effect<
  Awaited<ReturnType<typeof storage.acquire>> & Readonly<{ current: number }>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const fixture = yield* io(acquire);
    const { db, bucket } = fixture;
    yield* io(() => installTestSchema({ db }));
    yield* io(() => bucket.put("recovery/generation", "initial"));
    const current = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const digest = new Uint8Array(
      yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode("c".repeat(43))))
    );
    yield* io(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(userId, current),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-GHJK',?,?,'consumed',?,?)"
          )
          .bind(sessionId, digest, userId, current, current + 600000),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            sessionId,
            sessionId,
            userId,
            digest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
    return { ...fixture, current };
  });
const setup = setupOn(() => storage.acquire());
const request = (
  identity: Readonly<{ cookie: string; session: string }> = {
    cookie: "c".repeat(43),
    session: sessionId,
  }
): Request =>
  new Request("https://core.internal/dashboard/view", {
    headers: {
      origin: "https://app.fidy.test",
      cookie: `__Host-fidy_session=${identity.cookie}`,
      [browserSessionBindingHeader]: identity.session,
    },
  });

it.live(
  "audits an exact wide-Money snapshot using current layout and live cookie authority in one Store RPC",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const document = {
        title: "Exacto",
        layout: {
          kind: "leaf",
          widget: {
            id: "30000000-0000-4000-8000-000000000001",
            type: "custom-metric",
            label: "Gastos",
            period: "this-month",
            aggregation: "sum",
          },
        },
      };
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare(
              "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,7)"
            )
            .bind(userId, encodeJson(document)),
          fixture.db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('one',?,'123456789012345678901234567890.01','COP','outflow',(SELECT id FROM categories LIMIT 1),?,?)"
            )
            .bind(userId, fixture.current, fixture.current),
        ])
      );
      const actual = yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }));
      expect(actual).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              revision: 7,
              layout: {
                widget: {
                  result: {
                    moneyGroups: [
                      {
                        currency: "COP",
                        outflow: { amount: "123456789012345678901234567890.01", currency: "COP" },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        binding: sessionId,
        measurement: { scans: 1, financialRows: 1 },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT operation,outcome FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .all()
        )
      ).toMatchObject({
        results: [{ operation: "dashboard.getDashboardView", outcome: "accepted" }],
      });
    })
);

it.live(
  "returns the live binding in the audited document read while fragments still require their mounted binding",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const document = {
        title: "Documento",
        layout: {
          kind: "leaf",
          widget: {
            id: "30000000-0000-4000-8000-000000000001",
            type: "custom-metric",
            label: "Gastos",
            period: "this-month",
            aggregation: "sum",
          },
        },
      };
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,1)"
          )
          .bind(userId, encodeJson(document))
          .run()
      );
      const documentRequest = request();
      documentRequest.headers.delete(browserSessionBindingHeader);
      expect(
        yield* io(() => fixture.snapshot({ request: documentRequest, mode: "bound" }))
      ).toMatchObject({ kind: "response", response: { status: 401 } });
      expect(
        yield* io(() => fixture.snapshot({ request: documentRequest, mode: "document" }))
      ).toMatchObject({
        kind: "view",
        binding: sessionId,
        response: { status: 200, body: { data: { title: "Documento", revision: 1 } } },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .first()
        )
      ).toEqual({ count: 1 });
    })
);

it.live(
  "preserves canonical pressure refusal and standing without disclosing or auditing a financial view",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const reservedUntil = fixture.current + 1000000;
      yield* io(() =>
        fixture.db
          .prepare("INSERT INTO canonical_request_buckets(subject,virtual_at_ms) VALUES (?,?)")
          .bind(`user:${userId}`, reservedUntil)
          .run()
      );
      expect(
        yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }))
      ).toMatchObject({
        kind: "response",
        response: {
          status: 429,
          body: { error: { code: "rate_limited" } },
          headers: { "retry-after": "1" },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT virtual_at_ms FROM canonical_request_buckets WHERE subject=?")
            .bind(`user:${userId}`)
            .first()
        )
      ).toEqual({ virtual_at_ms: reservedUntil });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .first()
        )
      ).toEqual({ count: 0 });
    })
);

it.live("rolls back pressure and Audit when the Audit write is refused", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* io(() =>
      fixture.db
        .prepare(
          "CREATE TRIGGER refuse_native_dashboard_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.getDashboardView' BEGIN SELECT RAISE(ABORT,'native_dashboard_audit_refused'); END"
        )
        .run()
    );
    expect(yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }))).toMatchObject({
      kind: "response",
      response: { status: 503, body: { error: { code: "unavailable" } } },
    });
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM user_documents WHERE kind='dashboard'")
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

const otherUserId = "10000000-0000-4000-8000-000000000002";
const otherSessionId = "60000000-0000-4000-8000-000000000002";
const seedOtherUser = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const digest = new Uint8Array(
      yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode("d".repeat(43))))
    );
    yield* io(() =>
      input.db.batch([
        input.db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(otherUserId, input.current),
        input.db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-GHJL',?,?,'consumed',?,?)"
          )
          .bind(otherSessionId, digest, otherUserId, input.current, input.current + 600000),
        input.db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            otherSessionId,
            otherSessionId,
            otherUserId,
            digest,
            input.current,
            input.current + 600000,
            input.current + 3600000,
            input.current + 7776000000
          ),
      ])
    );
  });
const seedBothDocuments = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* seedOtherUser(input);
    const document = {
      title: "Privado",
      layout: {
        kind: "leaf",
        widget: {
          id: "30000000-0000-4000-8000-000000000001",
          type: "custom-metric",
          label: "Gastos",
          period: "this-month",
          aggregation: "sum",
        },
      },
    };
    for (const [index, user] of [userId, otherUserId].entries()) {
      yield* io(() =>
        input.db.batch([
          input.db
            .prepare(
              "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,1)"
            )
            .bind(user, encodeJson(document)),
          input.db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?, ?,?,'COP','outflow',(SELECT id FROM categories LIMIT 1),?,?)"
            )
            .bind(
              `transaction-${index}`,
              user,
              index === 0 ? "17" : "33",
              input.current,
              input.current
            ),
        ])
      );
    }
  });
for (const state of ["Draining", "Sealing"] as const) {
  it.live(
    `withholds a still-live User's financial view during Erasure ${state} without fencing another User`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        yield* seedBothDocuments(fixture);
        yield* io(() =>
          fixture.db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES ('erasure',?,?,?)"
            )
            .bind(userId, fixture.current, state)
            .run()
        );
        expect(
          yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }))
        ).toMatchObject({
          kind: "response",
          response: { status: 401, body: { error: { code: "unauthenticated" } } },
        });
        expect(
          yield* io(() =>
            fixture.snapshot({
              request: request({ cookie: "d".repeat(43), session: otherSessionId }),
              mode: "bound",
            })
          )
        ).toMatchObject({
          response: {
            status: 200,
            body: {
              data: {
                layout: {
                  widget: {
                    result: { moneyGroups: [{ outflow: { amount: "33", currency: "COP" } }] },
                  },
                },
              },
            },
          },
        });
        expect(
          yield* io(() =>
            fixture.db
              .prepare(
                "SELECT user_id FROM audit_entries WHERE operation='dashboard.getDashboardView'"
              )
              .all()
          )
        ).toMatchObject({ results: [{ user_id: otherUserId }] });
        expect(
          yield* io(() =>
            fixture.db
              .prepare("SELECT revoked_at_ms FROM web_sessions WHERE id=?")
              .bind(sessionId)
              .first()
          )
        ).toEqual({ revoked_at_ms: null });
      })
  );
}

for (const refusal of ["revoked", "withdrawn"] as const) {
  it.live(`withholds a ${refusal} credential's view while another User remains authorized`, () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* seedBothDocuments(fixture);
      if (refusal === "revoked") {
        yield* io(() =>
          fixture.db
            .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
            .bind(fixture.current, sessionId)
            .run()
        );
      } else {
        yield* io(() =>
          fixture.db.batch([
            fixture.db
              .prepare(
                "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','fixture-grant',?,'{}','disclosure','decision',?,?)"
              )
              .bind(userId, fixture.current - 1000, fixture.current - 1000),
            fixture.db
              .prepare(
                "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','withdrawal',?,'fixture-grant',?,?)"
              )
              .bind(userId, sessionId, fixture.current),
          ])
        );
      }
      expect(
        yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }))
      ).toMatchObject({
        kind: "response",
        response: { status: 401, body: { error: { code: "unauthenticated" } } },
      });
      expect(
        yield* io(() =>
          fixture.snapshot({
            request: request({ cookie: "d".repeat(43), session: otherSessionId }),
            mode: "bound",
          })
        )
      ).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              layout: {
                widget: {
                  result: { moneyGroups: [{ outflow: { amount: "33", currency: "COP" } }] },
                },
              },
            },
          },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT user_id FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .all()
        )
      ).toMatchObject({ results: [{ user_id: otherUserId }] });
    })
  );
}

it.live("fails closed under a newer recovery generation before any pressure or Audit write", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* io(() =>
      fixture.bucket.put("recovery/generation", "90000000-0000-4000-8000-000000000001")
    );
    expect(
      yield* io(() => fixture.snapshot({ request: request(), mode: "document" }))
    ).toMatchObject({ kind: "response", response: { status: 503 } });
    expect(
      yield* io(() =>
        fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

it.live(
  "plans every Widget from the current stored timezone and layout while sharing overlapping aggregate spans",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const categoryId = "10000000-0000-4000-8000-000000000001";
      const widgets = [
        {
          id: "30000000-0000-4000-8000-000000000001",
          type: "custom-metric",
          label: "Suma",
          period: "this-month",
          aggregation: "sum",
        },
        {
          id: "30000000-0000-4000-8000-000000000002",
          type: "custom-metric",
          label: "Máximo",
          period: "this-month",
          aggregation: "maximum",
        },
        {
          id: "30000000-0000-4000-8000-000000000003",
          type: "spending-chart",
          period: "this-month",
          groupBy: "day",
        },
        {
          id: "30000000-0000-4000-8000-000000000004",
          type: "budget-bar",
          categoryId,
          currency: "COP",
        },
        {
          id: "30000000-0000-4000-8000-000000000005",
          type: "transaction-list",
          categories: [categoryId],
          limit: 1,
          search: "café",
        },
      ];
      const document = {
        title: "Todos",
        layout: {
          kind: "split",
          axis: "row",
          children: widgets.map((widget) => ({ weight: 1, node: { kind: "leaf", widget } })),
        },
      };
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare("UPDATE users SET time_zone='Pacific/Kiritimati' WHERE id=?")
            .bind(userId),
          fixture.db
            .prepare(
              "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,11)"
            )
            .bind(userId, encodeJson(document)),
          fixture.db
            .prepare(
              "INSERT INTO budgets(id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms) VALUES ('50000000-0000-4000-8000-000000000001',?,?,'COP','100',?,?)"
            )
            .bind(userId, categoryId, fixture.current, fixture.current),
          ...["10", "2.02"].map((amount, index) =>
            fixture.db
              .prepare(
                "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES (?,?,?,'COP','outflow',?,'CAFÉ',?,?)"
              )
              .bind(
                `40000000-0000-4000-8000-00000000000${index + 2}`,
                userId,
                amount,
                categoryId,
                fixture.current + index,
                fixture.current
              )
          ),
        ])
      );
      const actual = yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }));
      expect(actual).toMatchObject({
        measurement: { scans: 1, financialRows: 2 },
        response: {
          status: 200,
          body: {
            data: {
              revision: 11,
              context: { timeZone: "Pacific/Kiritimati" },
              layout: {
                children: [
                  {
                    node: {
                      widget: { result: { moneyGroups: [{ outflow: { amount: "12.02" } }] } },
                    },
                  },
                  {
                    node: { widget: { result: { moneyGroups: [{ outflow: { amount: "10" } }] } } },
                  },
                  {
                    node: {
                      widget: {
                        result: { buckets: [{ moneyGroups: [{ outflow: { amount: "12.02" } }] }] },
                      },
                    },
                  },
                  {
                    node: {
                      widget: {
                        result: {
                          availability: "available",
                          cap: { amount: "100" },
                          spent: { amount: "12.02" },
                        },
                      },
                    },
                  },
                  {
                    node: {
                      widget: {
                        result: {
                          transactions: [
                            {
                              id: "40000000-0000-4000-8000-000000000003",
                              money: { amount: "2.02" },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    })
);

it.live("validates retained layout before committing pressure, Audit or a response", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* io(() =>
      fixture.db
        .prepare(
          "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,1)"
        )
        .bind(
          userId,
          encodeJson({ title: "Invalid", layout: { kind: "leaf", widget: { type: "unknown" } } })
        )
        .run()
    );
    expect(yield* io(() => fixture.snapshot({ request: request(), mode: "bound" }))).toMatchObject({
      kind: "response",
      response: { status: 503 },
    });
    expect(
      yield* io(() =>
        fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

it.live(
  "returns same-transaction document bootstrap metadata with the exact native financial view",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare(
              "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=?,time_zone='Pacific/Kiritimati' WHERE id=?"
            )
            .bind(fixture.current, fixture.current + 604800000, userId),
          fixture.db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','context-grant',?,'{}','disclosure','decision',?,?)"
            )
            .bind(userId, fixture.current, fixture.current),
          fixture.db
            .prepare(
              "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,19)"
            )
            .bind(
              userId,
              encodeJson({
                title: "Contexto",
                layout: {
                  kind: "leaf",
                  widget: {
                    id: "30000000-0000-4000-8000-000000000001",
                    type: "custom-metric",
                    label: "Gastos",
                    period: "this-month",
                    aggregation: "sum",
                  },
                },
              })
            ),
        ])
      );
      const initial = request();
      initial.headers.delete(browserSessionBindingHeader);
      expect(
        yield* io(() => fixture.snapshot({ request: initial, mode: "document" }))
      ).toMatchObject({
        kind: "view",
        binding: sessionId,
        bootstrap: {
          binding: sessionId,
          initial: {
            status: "Granted",
            withdrawal: null,
            profile: { data: { id: userId, timeZone: "Pacific/Kiritimati" } },
          },
        },
        response: { status: 200, body: { data: { title: "Contexto", revision: 19 } } },
      });
    })
);

it.live(
  "withholds the whole document when its identity Audit refuses and rolls back native admission",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare("UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?")
            .bind(fixture.current, fixture.current + 604800000, userId),
          fixture.db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','context-grant',?,'{}','disclosure','decision',?,?)"
            )
            .bind(userId, fixture.current, fixture.current),
          fixture.db.prepare(
            "CREATE TRIGGER refuse_document_identity BEFORE INSERT ON audit_entries WHEN NEW.record_type='identity_read' BEGIN SELECT RAISE(ABORT,'identity_audit_refused'); END"
          ),
        ])
      );
      const initial = request();
      initial.headers.delete(browserSessionBindingHeader);
      expect(
        yield* io(() => fixture.snapshot({ request: initial, mode: "document" }))
      ).toMatchObject({ kind: "response", response: { status: 503 } });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* io(() => fixture.db.prepare("SELECT count(*) AS count FROM audit_entries").first())
      ).toEqual({ count: 0 });
    })
);

it.live(
  "uses the named private document entry without granting document mode to fragments or alternate bearers",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setupOn(() => storage.acquireDocument("Live"));
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,23)"
          )
          .bind(
            userId,
            encodeJson({
              title: "<Documento>",
              layout: {
                kind: "leaf",
                widget: {
                  id: "30000000-0000-4000-8000-000000000001",
                  type: "custom-metric",
                  label: "Gastos",
                  period: "this-month",
                  aggregation: "sum",
                },
              },
            })
          )
          .run()
      );
      const headers = request().headers;
      headers.set("authorization", "Bearer alternate-user");
      headers.set(browserSessionBindingHeader, "60000000-0000-4000-8000-000000000099");
      headers.set("origin", "https://foreign.test");
      const incoming = new Request("https://app.fidy.test/app/dashboard", { headers });
      const transfer = yield* io(() => fixture.document(incoming));
      expect(transfer).toMatchObject({
        kind: "snapshot",
        status: 200,
        bootstrap: { binding: sessionId, initial: { status: "Missing" } },
      });
      expect(transfer).toMatchObject({
        fixtureCounters: { nativeRpc: 1, r2Get: 1, genericRpc: 0 },
      });
      const rendered = yield* Schema.decodeUnknownEffect(Schema.Struct({ html: Schema.String }))(
        transfer
      );
      expect(rendered.html).toContain("&lt;Documento&gt;");
      expect(
        yield* io(() =>
          fixture.snapshot({
            request: request({
              cookie: "c".repeat(43),
              session: "60000000-0000-4000-8000-000000000099",
            }),
            mode: "bound",
          })
        )
      ).toMatchObject({ kind: "response", response: { status: 401 } });
    })
);

it.live(
  "preserves deployment recovery isolation at the named document entry before any financial read",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setupOn(() => storage.acquireDocument("Isolated"));
      expect(
        yield* io(() =>
          fixture.document(
            new Request("https://app.fidy.test/app/dashboard", { headers: request().headers })
          )
        )
      ).toMatchObject({
        kind: "refused",
        status: 503,
        fixtureCounters: { nativeRpc: 0, r2Get: 0 },
      });
      expect(
        yield* io(() => fixture.db.prepare("SELECT count(*) AS count FROM audit_entries").first())
      ).toEqual({ count: 0 });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
        )
      ).toEqual({ count: 0 });
    })
);

const patSnapshotFixture = Effect.gen(function* () {
  const fixture = yield* setup;
  const bearer = `fin_token001_${"c".repeat(43)}`;
  const digest = new Uint8Array(
    yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)))
  );
  const document = {
    title: "PAT nativo",
    layout: {
      kind: "leaf",
      widget: {
        id: "30000000-0000-4000-8000-000000000001",
        type: "custom-metric",
        label: "Gastos",
        period: "this-month",
        aggregation: "sum",
      },
    },
  };
  yield* io(() =>
    fixture.db.batch([
      fixture.db
        .prepare(
          "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES ('native-pat',?,'token001',?,'Native agent','[\"read\"]',30,?,?,?,'native-pat-request')"
        )
        .bind(userId, digest, fixture.current, fixture.current, fixture.current + 3600000),
      fixture.db
        .prepare(
          "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,7)"
        )
        .bind(userId, encodeJson(document)),
      fixture.db
        .prepare(
          "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('pat-wide',?,'123456789012345678901234567890.01','COP','outflow',(SELECT id FROM categories LIMIT 1),?,?)"
        )
        .bind(userId, fixture.current, fixture.current),
    ])
  );
  return { ...fixture, bearer };
});

it.live(
  "commits PAT admission, exact financial view, allowance and accepted activity in one native Store read",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      const actual = yield* io(() =>
        fixture.snapshot({
          mode: "bound",
          request: new Request("https://core.internal/dashboard/view", {
            headers: { authorization: `Bearer ${fixture.bearer}` },
          }),
        })
      );
      expect(actual).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              title: "PAT nativo",
              revision: 7,
              layout: {
                widget: {
                  result: {
                    moneyGroups: [
                      { currency: "COP", outflow: { amount: "123456789012345678901234567890.01" } },
                    ],
                  },
                },
              },
            },
          },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE record_type='credential_call' AND operation='dashboard.getDashboardView' AND outcome='accepted'"
            )
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT last_used_at_ms AS lastUsed FROM pats WHERE id='native-pat'")
            .first<number>("lastUsed")
        )
      ).toBeGreaterThan(0);
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM commercial_allowance_consumptions WHERE user_id=? AND allowance='canonical_call'"
            )
            .bind(userId)
            .first()
        )
      ).toEqual({ count: 1 });
    })
);

type PATFixture = Effect.Success<typeof patSnapshotFixture>;
const patRead = (
  fixture: PATFixture,
  headers: Record<string, string> = {}
): Promise<NativeDashboardResult> =>
  fixture
    .snapshot({
      mode: "bound",
      request: new Request("https://core.internal/dashboard/view", {
        headers: { authorization: `Bearer ${fixture.bearer}`, ...headers },
      }),
    })
    .then(Schema.decodeUnknownSync(NativeDashboardResult));

it.live(
  "refuses a live PAT without read scope, audits the refusal and discloses standing without charging",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      yield* io(() =>
        fixture.db.prepare("UPDATE pats SET scopes_json='[\"write\"]' WHERE id='native-pat'").run()
      );
      expect(yield* io(() => patRead(fixture))).toMatchObject({
        response: {
          status: 403,
          body: { error: { code: "scope_missing" } },
          headers: { "fidy-canonical-remaining": "50" },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT outcome FROM audit_entries WHERE record_type='credential_call'")
            .all()
        )
      ).toMatchObject({ results: [{ outcome: "rejected" }] });
    })
);

it.live(
  "replays the exact PAT envelope without reading changed facts or spending another commercial unit",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      const headers = { "Fidy-Retry-Key": "native-snapshot-retry" };
      const first = yield* io(() => patRead(fixture, headers));
      yield* io(() =>
        fixture.db.prepare("UPDATE transactions SET amount='2.01' WHERE id='pat-wide'").run()
      );
      const replay = yield* io(() => patRead(fixture, headers));
      expect(replay.response.body).toEqual(first.response.body);
      expect(replay.response.status).toBe(200);
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE record_type='credential_call' AND outcome='accepted'"
            )
            .first()
        )
      ).toEqual({ count: 2 });
      yield* io(() =>
        fixture.db
          .prepare("UPDATE pats SET revoked_at_ms=? WHERE id='native-pat'")
          .bind(fixture.current)
          .run()
      );
      expect(yield* io(() => patRead(fixture, headers))).toMatchObject({
        response: { status: 401 },
      });
    })
);

it.live("rolls back the PAT charge, pressure and activity when native financial Audit fails", () =>
  Effect.gen(function* () {
    const fixture = yield* patSnapshotFixture;
    yield* io(() =>
      fixture.db.exec(
        "CREATE TRIGGER reject_native_pat_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' BEGIN SELECT RAISE(ABORT,'synthetic native audit failure'); END"
      )
    );
    expect(yield* io(() => patRead(fixture))).toMatchObject({
      response: { status: 503, body: { error: { code: "unavailable" } } },
    });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT last_used_at_ms AS lastUsed FROM pats WHERE id='native-pat'")
          .first()
      )
    ).toEqual({ lastUsed: null });
  })
);

it.live("preserves an exhausted PAT allowance refusal without releasing financial data", () =>
  Effect.gen(function* () {
    const fixture = yield* patSnapshotFixture;
    const period = DateTime.toEpochMillis(
      allowancePeriod(DateTime.makeUnsafe(fixture.current)).startsAt
    );
    yield* io(() =>
      fixture.db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${freeAllowanceLimits.canonical_call}) INSERT INTO commercial_allowance_consumptions SELECT ?, 'canonical_call', 'prior-'||i, ?, ?, 1 FROM n`
        )
        .bind(userId, period, fixture.current)
        .run()
    );
    expect(yield* io(() => patRead(fixture))).toMatchObject({
      response: {
        status: 429,
        body: { error: { code: "quota_exhausted" } },
        headers: { "fidy-canonical-remaining": "0" },
      },
    });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: freeAllowanceLimits.canonical_call });
  })
);

it.live("applies the trusted source envelope only to unresolved native PAT calls", () =>
  Effect.gen(function* () {
    const fixture = yield* patSnapshotFixture;
    const statuses: number[] = [];
    for (let index = 0; index < 11; index++) {
      const result = yield* io(() =>
        patRead(fixture, {
          authorization: `Bearer fin_missing1_${"c".repeat(43)}`,
          "x-canonical-source": "d".repeat(64),
        })
      );
      statuses.push(result.response.status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 401), 429]);
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

const coreBindings = (store: NonNullable<CoreHttpBindings["SQLITE_STORE"]>): CoreHttpBindings => ({
  SQLITE_STORE: store,
  SQLITE_STORE_MANIFEST: "fixture",
  SQLITE_STORE_EPOCH: "fixture",
  RELEASE_GIT_SHA: "0".repeat(40),
  CONTRACT_DIGEST: "0".repeat(64),
  BROWSER_ORIGIN: "https://app.fidy.test",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({
      fetch: () => Promise.reject(new Error("Dashboard read must not enter coordinator")),
    }),
  },
  KAPSO_API_KEY: "unused",
  KAPSO_WEBHOOK_SECRET: "unused",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "unused",
  CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
  CLOUDFLARE_ACCESS_AUDIENCE: "unused",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
});

it.live(
  "routes public PAT Dashboard JSON and HTML through one actual native snapshot with no legacy SQL",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      let nativeCalls = 0;
      let genericQueries = 0;
      const environment = coreBindings({
        getByName: () => ({
          query: (): Promise<never> => {
            genericQueries++;
            return Promise.reject(new Error("No legacy SQL"));
          },
          dashboard: (input): Promise<unknown> => {
            nativeCalls++;
            return fixture.snapshot(input);
          },
        }),
      });
      const core = makeCoreHttp({
        telemetry: cloudflareWorkerTelemetry,
        institutions: registeredConnectionInstitutionIds,
      });
      for (const accept of ["application/json", "text/html"]) {
        const response = yield* io(() =>
          core(
            new Request("https://api.fidy.test/dashboard/view", {
              headers: { authorization: `Bearer ${fixture.bearer}`, accept },
            }),
            environment
          )
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(accept);
        const body = yield* io(() => response.text());
        expect(body).toContain("PAT nativo");
        expect(body).not.toContain("NaN");
      }
      expect(nativeCalls).toBe(2);
      expect(genericQueries).toBe(0);
    })
);

it.live(
  "preserves cookie lifetime binding before PAT work without falling back to cookie authority",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      const cookie = `__Host-fidy_session=${"c".repeat(43)}`;
      expect((yield* io(() => patRead(fixture, { cookie }))).response.status).toBe(401);
      expect(
        (yield* io(() => patRead(fixture, { cookie, [browserSessionBindingHeader]: sessionId })))
          .response.status
      ).toBe(200);
      expect(
        (yield* io(() =>
          patRead(fixture, {
            cookie,
            [browserSessionBindingHeader]: sessionId,
            authorization: "Bearer invalid",
          })
        )).response.status
      ).toBe(401);
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 1 });
    })
);

it.live("accepts the provider's actual private Dashboard RPC binding without an HTTP facade", () =>
  Effect.gen(function* () {
    const native = yield* io(() => storage.acquireDocument("Live"));
    const fixture = yield* setupOn(() => Promise.resolve(native));
    const result = yield* io(() =>
      native.namespace.getByName("authoritative-v1").dashboard({
        manifest: "fixture",
        epoch: "fixture",
        mode: "bound",
        request: request(),
      })
    );
    expect(result).toMatchObject({
      kind: "response",
      response: { status: 404, body: { error: { code: "dashboard_uninitialized" } } },
    });
    expect(result).toMatchObject({ fixtureCounters: { nativeRpc: 1, r2Get: 1, r2Head: 0 } });
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 1 });
  })
);

type OAuthFixture = PATFixture & Readonly<{ admission: OAuthCanonicalAdmission }>;
const oauthSnapshotFixture = (
  scopes: ReadonlyArray<"read" | "write"> = ["read"]
): Effect.Effect<OAuthFixture, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const fixture = yield* patSnapshotFixture;
    const connectionId = "70000000-0000-4000-8000-000000000001";
    const clientId = "70000000-0000-4000-8000-000000000002";
    const credentialId = "70000000-0000-4000-8000-000000000003";
    const digest = new Uint8Array(32).fill(7);
    const statements = [
      fixture.db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','native-processing-grant',?,'{}','disclosed','accepted',?,?)"
        )
        .bind(userId, fixture.current, fixture.current),
      fixture.db
        .prepare(
          "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms) VALUES (?,'native-oauth-request',?,?,'Native OAuth','https://agent.test/callback','https://api.fidyapp.com/mcp',json(?),?,?)"
        )
        .bind(
          connectionId,
          userId,
          clientId,
          encodeJson(scopes),
          fixture.current,
          fixture.current + 3600000
        ),
      fixture.db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,connection_id,session_id,disclosure_json,occurred_at_ms) VALUES ('oauth_grant','native-oauth-grant',?,?,?,json_object('revision','fixture','text','Synthetic grant'),?)"
        )
        .bind(userId, connectionId, sessionId, fixture.current),
      fixture.db
        .prepare(
          "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES ('access',?,?,?,?,?,?,json(?))"
        )
        .bind(
          credentialId,
          connectionId,
          userId,
          digest,
          fixture.current,
          fixture.current + 3600000,
          encodeJson(scopes)
        ),
    ];
    yield* io(() => fixture.db.batch(statements));
    const admission = yield* Schema.decodeEffect(OAuthCanonicalAdmission)({
      userId,
      connectionId,
      credentialId,
      clientId,
      digest: Array.from(digest),
      resource: "https://api.fidyapp.com/mcp",
      operation: "dashboard.getDashboardView",
      input: {},
      deadlineMilliseconds: fixture.current + 30000,
    });
    return { ...fixture, admission };
  });

it.live(
  "rechecks OAuth authority and accounts the exact Dashboard in the native financial unit",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthSnapshotFixture();
      const result = yield* io(() =>
        fixture.snapshot({
          mode: "oauth",
          admission: fixture.admission,
          request: new Request("https://core.internal/dashboard/view"),
        })
      );
      expect(result).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              title: "PAT nativo",
              revision: 7,
              layout: {
                widget: {
                  result: {
                    moneyGroups: [
                      {
                        currency: "COP",
                        outflow: { amount: "123456789012345678901234567890.01" },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE oauth_connection_id=? AND oauth_credential_id=? AND operation='dashboard.getDashboardView' AND outcome='accepted'"
            )
            .bind(fixture.admission.connectionId, fixture.admission.credentialId)
            .first()
        )
      ).toEqual({ count: 1 });
    })
);

const mcpFrame = (
  admission: OAuthCanonicalAdmission,
  body: Schema.Json,
  session: Option.Option<string>
): Effect.Effect<OAuthMcpAdmission, Schema.SchemaError> =>
  Schema.decodeEffect(OAuthMcpAdmission)({
    userId: admission.userId,
    connectionId: admission.connectionId,
    credentialId: admission.credentialId,
    clientId: admission.clientId,
    resource: admission.resource,
    digest: admission.digest,
    deadlineMilliseconds: admission.deadlineMilliseconds,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...Option.match(session, { onNone: () => ({}), onSome: (id) => ({ "mcp-session-id": id }) }),
    },
    body: Array.from(new TextEncoder().encode(encodeJson(body))),
  });

it.live(
  "uses the native financial unit from the real MCP SDK without the foreground canonical queue",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthSnapshotFixture();
      let legacyCalls = 0;
      let nativeCalls = 0;
      const module = makeMcpResidency({
        userId,
        db: fixture.db,
        dashboard: Option.some((input) => {
          nativeCalls++;
          return fixture.snapshot(input);
        }),
        enqueueCanonicalWork: () =>
          Effect.sync(() => {
            legacyCalls++;
            return new Response(null, { status: 503 });
          }),
      });
      const invoke = (
        body: Schema.Json,
        session: Option.Option<string>
      ): Effect.Effect<Response, Schema.SchemaError> =>
        mcpFrame(fixture.admission, body, session).pipe(
          Effect.flatMap((admission) =>
            module.handle({ admission, signal: new AbortController().signal })
          )
        );
      try {
        const initialized = yield* invoke(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "native-dashboard-test", version: "1" },
            },
          },
          Option.none()
        );
        const session = Option.fromNullOr(initialized.headers.get("mcp-session-id"));
        yield* io(() => initialized.text());
        yield* invoke({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
        const response = yield* invoke(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "dashboard.getDashboardView",
              arguments: {},
            },
          },
          session
        );
        expect(response.status).toBe(200);
        const body = yield* io(() => response.text());
        expect(body).toContain("PAT nativo");
        expect(body).toContain("123456789012345678901234567890.01");
        expect(nativeCalls).toBe(1);
        expect(legacyCalls).toBe(0);
        expect(
          yield* io(() =>
            fixture.db
              .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
              .first()
          )
        ).toEqual({ count: 1 });
      } finally {
        yield* module.dispose();
      }
    })
);

const oauthRead = (
  fixture: OAuthFixture,
  overrides: Partial<typeof OAuthCanonicalAdmission.Encoded> = {}
): Effect.Effect<NativeDashboardResult, Cause.UnknownError | Schema.SchemaError> =>
  Schema.decodeEffect(OAuthCanonicalAdmission)({ ...fixture.admission, ...overrides }).pipe(
    Effect.flatMap((admission) =>
      io(() =>
        fixture.snapshot({
          mode: "oauth",
          admission,
          request: new Request("https://core.internal/dashboard/view"),
        })
      )
    )
  );

it.live("refuses forged OAuth caller facts and expired handoffs before financial accounting", () =>
  Effect.gen(function* () {
    const fixture = yield* oauthSnapshotFixture();
    for (const overrides of [
      { digest: Array.from(new Uint8Array(32).fill(8)) },
      { userId: "70000000-0000-4000-8000-000000000004" },
      { clientId: "70000000-0000-4000-8000-000000000004" },
    ]) {
      expect((yield* oauthRead(fixture, overrides)).response.status).toBe(401);
    }
    expect(
      (yield* oauthRead(fixture, { deadlineMilliseconds: fixture.current - 1 })).response.status
    ).toBe(503);
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare(
            "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
          )
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

it.live("audits a native OAuth read-scope refusal without spending a commercial unit", () =>
  Effect.gen(function* () {
    const fixture = yield* oauthSnapshotFixture(["write"]);
    expect(yield* oauthRead(fixture)).toMatchObject({
      response: {
        status: 403,
        body: { error: { code: "scope_missing" } },
        headers: { "fidy-canonical-remaining": "50" },
      },
    });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT outcome FROM audit_entries WHERE operation='dashboard.getDashboardView'")
          .first()
      )
    ).toEqual({ outcome: "rejected" });
  })
);

it.live(
  "replays native OAuth results without recharging and rechecks withdrawn Consent before disclosure",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthSnapshotFixture();
      const key = { retryKey: "native_oauth_retry" };
      const first = yield* oauthRead(fixture, key);
      expect(first.response.status).toBe(200);
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('oauth-later',?,'99.00','COP','outflow',(SELECT id FROM categories LIMIT 1),?,?)"
          )
          .bind(userId, fixture.current, fixture.current)
          .run()
      );
      const replay = yield* oauthRead(fixture, key);
      expect(replay.response.body).toEqual(first.response.body);
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','native-withdrawal',?,'native-processing-grant',?,?)"
          )
          .bind(userId, sessionId, fixture.current)
          .run()
      );
      expect(yield* oauthRead(fixture, key)).toMatchObject({
        response: { status: 403, body: { error: { code: "user_action_required" } } },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .first()
        )
      ).toEqual({ count: 2 });
    })
);

it.live("rolls back native OAuth charge and pressure when its financial Audit fails", () =>
  Effect.gen(function* () {
    const fixture = yield* oauthSnapshotFixture();
    yield* io(() =>
      fixture.db.exec(
        "CREATE TRIGGER reject_native_oauth_audit BEFORE INSERT ON audit_entries WHEN NEW.oauth_connection_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic OAuth audit failure'); END"
      )
    );
    expect((yield* oauthRead(fixture)).response.status).toBe(503);
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
    expect(
      yield* io(() =>
        fixture.db.prepare("SELECT count(*) AS count FROM canonical_request_buckets").first()
      )
    ).toEqual({ count: 0 });
  })
);

it.live("keeps native R2 observations separate across concurrent provider calls", () =>
  Effect.gen(function* () {
    const native = yield* io(() => storage.acquireDocument("Live"));
    yield* setupOn(() => Promise.resolve(native));
    const call = (): Promise<unknown> =>
      native.namespace.getByName("authoritative-v1").dashboard({
        manifest: "fixture",
        epoch: "fixture",
        mode: "bound",
        request: request(),
      });
    const results = yield* Effect.all([io(call), io(call)], { concurrency: "unbounded" });
    for (const result of results) {
      expect(result).toMatchObject({
        fixtureCounters: { nativeRpc: 1, entryRpc: 0, genericRpc: 0, r2Get: 1 },
      });
    }
  })
);

it.live("applies a trusted logical clock offset only inside its isolated native fixture", () =>
  Effect.gen(function* () {
    const oneDayMilliseconds = 86400000;
    const native = yield* io(() =>
      storage.acquireDocument("Live", {
        browserOrigin: "https://app.fidy.test",
        clockOffset: Option.some(-oneDayMilliseconds),
      })
    );
    yield* setupOn(() => Promise.resolve(native));
    const before = yield* Clock.currentTimeMillis;
    const raw = yield* io(() =>
      native.namespace
        .getByName("authoritative-v1")
        .dashboard({ manifest: "fixture", epoch: "fixture", mode: "bound", request: request() })
    );
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ fixtureCounters: Schema.Struct({ nativeClock: Schema.Finite }) })
    )(raw);
    const after = yield* Clock.currentTimeMillis;
    expect(observed.fixtureCounters.nativeClock).toBeGreaterThanOrEqual(
      before - oneDayMilliseconds
    );
    expect(observed.fixtureCounters.nativeClock).toBeLessThanOrEqual(after - oneDayMilliseconds);
  })
);

const hostedSnapshotFixture = Effect.gen(function* () {
  const fixture = yield* patSnapshotFixture;
  const turnId = "80000000-0000-4000-8000-000000000001";
  const hostedSession = "80000000-0000-4000-8000-000000000002";
  const digest = new Uint8Array(
    yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode("c".repeat(43))))
  );
  yield* io(() =>
    fixture.db.batch([
      fixture.db.prepare(
        "UPDATE transactions SET id='90000000-0000-4000-8000-000000000001' WHERE id='pat-wide'"
      ),
      fixture.db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','hosted-processing',?,'{}','disclosed','accepted',?,?)"
        )
        .bind(userId, fixture.current, fixture.current),
      fixture.db
        .prepare(
          "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,'{}',?,'active')"
        )
        .bind(hostedSession, userId, fixture.current),
      fixture.db
        .prepare(
          "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,status) VALUES (?,?,?,?,'pending')"
        )
        .bind(turnId, userId, hostedSession, fixture.current),
      fixture.db
        .prepare(
          "INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,iteration,tool_call_id,operation,input_json) VALUES ('hosted-tool-entry',?,?,?,'tool_call',?,1,'native-hosted-call','dashboard.getDashboardView','{}')"
        )
        .bind(userId, hostedSession, turnId, fixture.current),
    ])
  );
  const admission = yield* Schema.decodeEffect(HostedDashboardAdmission)({
    subject: { _tag: "Browser", userId, id: sessionId, digest: Array.from(digest) },
    turnId,
    toolCallId: "native-hosted-call",
    iteration: 1,
    input: {},
    deadlineMilliseconds: fixture.current + 30000,
  });
  return { ...fixture, admission };
});

it.live(
  "reads an exact Hosted aggregate under the current pending Turn without spending a history or canonical unit",
  () =>
    Effect.gen(function* () {
      const fixture = yield* hostedSnapshotFixture;
      const result = yield* io(() =>
        fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
      );
      expect(result).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              revision: 7,
              layout: {
                widget: {
                  result: {
                    moneyGroups: [
                      {
                        currency: "COP",
                        outflow: { amount: "123456789012345678901234567890.01", currency: "COP" },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT operation,outcome,session_id FROM audit_entries").all()
        )
      ).toMatchObject({
        results: [
          { operation: "dashboard.getDashboardView", outcome: "accepted", session_id: sessionId },
        ],
      });
    })
);

it.live("charges saved Hosted Dashboard rows once per Turn and never spends a canonical call", () =>
  Effect.gen(function* () {
    const fixture = yield* hostedSnapshotFixture;
    yield* io(() =>
      fixture.db
        .prepare("UPDATE user_documents SET document_json=? WHERE user_id=? AND kind='dashboard'")
        .bind(
          encodeJson({
            title: "Historia",
            layout: {
              kind: "leaf",
              widget: {
                id: "30000000-0000-4000-8000-000000000001",
                type: "transaction-list",
                limit: 1,
              },
            },
          }),
          userId
        )
        .run()
    );
    for (let index = 0; index < 2; index++) {
      expect(
        yield* io(() =>
          fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
        )
      ).toMatchObject({
        response: {
          status: 200,
          body: {
            data: {
              layout: {
                widget: {
                  result: {
                    transactions: [
                      { money: { amount: "123456789012345678901234567890.01", currency: "COP" } },
                    ],
                  },
                },
              },
            },
          },
        },
      });
    }
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT allowance,identity,units FROM commercial_allowance_consumptions")
          .all()
      )
    ).toMatchObject({
      results: [{ allowance: "hosted_history_turn", identity: fixture.admission.turnId, units: 1 }],
    });
  })
);

it.live(
  "withholds Hosted rows when the history allowance is exhausted while keeping aggregates free",
  () =>
    Effect.gen(function* () {
      const fixture = yield* hostedSnapshotFixture;
      const period = DateTime.toEpochMillis(
        allowancePeriod(DateTime.makeUnsafe(fixture.current)).startsAt
      );
      yield* io(() =>
        fixture.db.batch(
          Array.from({ length: freeAllowanceLimits.hosted_history_turn }, (_, index) =>
            fixture.db
              .prepare(
                "INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units) VALUES (?,'hosted_history_turn',?,?,?,1)"
              )
              .bind(userId, `prior-${index}`, period, fixture.current)
          )
        )
      );
      expect(
        yield* io(() =>
          fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
        )
      ).toMatchObject({ response: { status: 200 } });
      yield* io(() =>
        fixture.db
          .prepare("UPDATE user_documents SET document_json=? WHERE user_id=? AND kind='dashboard'")
          .bind(
            encodeJson({
              title: "Historia",
              layout: {
                kind: "leaf",
                widget: {
                  id: "30000000-0000-4000-8000-000000000001",
                  type: "transaction-list",
                  limit: 1,
                },
              },
            }),
            userId
          )
          .run()
      );
      const result = yield* io(() =>
        fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
      );
      expect(result).toMatchObject({
        response: {
          status: 429,
          body: { error: { code: "quota_exhausted", allowance: "hosted_history_turn" } },
        },
      });
      expect(encodeJson(result)).not.toContain("123456789012345678901234567890.01");
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT outcome FROM audit_entries ORDER BY rowid").all()
        )
      ).toMatchObject({ results: [{ outcome: "accepted" }, { outcome: "rejected" }] });
    })
);

it.live(
  "refuses forged Hosted credential or tool identity and rolls back history consumption if Audit fails",
  () =>
    Effect.gen(function* () {
      const fixture = yield* hostedSnapshotFixture;
      for (const admission of [
        {
          ...fixture.admission,
          subject: { ...fixture.admission.subject, digest: Array.from(new Uint8Array(32)) },
        },
        {
          ...fixture.admission,
          toolCallId: yield* Schema.decodeEffect(HostedDashboardAdmission.fields.toolCallId)(
            "foreign-tool"
          ),
        },
        { ...fixture.admission, deadlineMilliseconds: 1 },
      ]) {
        expect(
          (yield* io(() => fixture.snapshot({ mode: "hosted", admission, request: request() })))
            .response.status
        ).not.toBe(200);
      }
      expect(
        yield* io(() => fixture.db.prepare("SELECT count(*) AS count FROM audit_entries").first())
      ).toEqual({ count: 0 });
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare(
              "UPDATE user_documents SET document_json=? WHERE user_id=? AND kind='dashboard'"
            )
            .bind(
              encodeJson({
                title: "Historia",
                layout: {
                  kind: "leaf",
                  widget: {
                    id: "30000000-0000-4000-8000-000000000001",
                    type: "transaction-list",
                    limit: 1,
                  },
                },
              }),
              userId
            ),
          fixture.db.prepare(
            "CREATE TRIGGER fail_hosted_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT,'commercial_quota_exhausted: SQLITE_CONSTRAINT'); END"
          ),
        ])
      );
      expect(
        yield* io(() =>
          fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
        )
      ).toMatchObject({ response: { status: 503 } });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ count: 0 });
    })
);

it.live(
  "executes a Hosted Dashboard tool through the real native Store before publishing the result to inference",
  () =>
    Effect.gen(function* () {
      const fixture = yield* patSnapshotFixture;
      const digest = new Uint8Array(
        yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode("c".repeat(43))))
      );
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','a0000000-0000-4000-8000-000000000001',?,?,'disclosed','accepted',?,?)"
          )
          .bind(userId, encodeJson(currentDisclosureFor()), fixture.current, fixture.current)
          .run()
      );
      let nativeCalls = 0;
      const modelInputs: unknown[] = [];
      const service = makeAgentService({
        environment: {
          DB: fixture.db,
          HOSTED_AI_MODEL: approvedOpenAiModel,
          OPENAI_API_KEY: openAiTestKey({
            run: (_model, input) => {
              modelInputs.push(input);
              return Promise.resolve(
                Response.json({
                  choices: [
                    {
                      message:
                        modelInputs.length === 1
                          ? {
                              role: "assistant",
                              content: null,
                              tool_calls: [
                                {
                                  id: "hosted-dashboard-live",
                                  type: "function",
                                  function: {
                                    name: "dashboard__getDashboardView",
                                    arguments: "{}",
                                  },
                                },
                              ],
                            }
                          : { role: "assistant", content: "Tu resumen está listo." },
                      finish_reason: modelInputs.length === 1 ? "tool_calls" : "stop",
                    },
                  ],
                  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
                })
              );
            },
          }),
        },
        userId: UserId.make(userId),
        connectionAdmission: Option.none(),
        scheduleRecovery: () => Promise.resolve(),
        dashboard: Option.some(({ admission, signal }) =>
          io(() => {
            nativeCalls++;
            return fixture.snapshot({
              mode: "hosted",
              admission,
              request: new Request("https://core.internal/dashboard/view", { signal }),
            });
          }).pipe(
            Effect.map(({ response }) =>
              Response.json(response.body, { status: response.status, headers: response.headers })
            ),
            Effect.orElseSucceed(() => new Response(null, { status: 503 }))
          )
        ),
      });
      const accepted = service.accept({
        preceding: Promise.resolve(),
        request: new Request("https://coordinator.internal/hosted-turn", {
          method: "POST",
          body: encodeJson({
            userId,
            sessionId,
            digest: Array.from(digest),
            text: "Muéstrame el resumen de gastos",
          }),
        }),
      });
      if (Option.isNone(accepted)) return yield* Effect.die("missing hosted request");
      const response = yield* io(() => accepted.value.response);
      yield* io(() => accepted.value.settled);
      expect(response.status).toBe(202);
      expect(nativeCalls).toBe(1);
      expect(modelInputs).toHaveLength(2);
      expect(encodeJson(modelInputs[1])).toContain("123456789012345678901234567890.01");
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT operation,outcome,session_id FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .all()
        )
      ).toMatchObject({
        results: [
          { operation: "dashboard.getDashboardView", outcome: "accepted", session_id: sessionId },
        ],
      });
    })
);

it.live("keeps an empty Hosted list free and withholds later reads after Consent withdrawal", () =>
  Effect.gen(function* () {
    const fixture = yield* hostedSnapshotFixture;
    yield* io(() =>
      fixture.db.batch([
        fixture.db.prepare("DELETE FROM transactions WHERE user_id=?").bind(userId),
        fixture.db
          .prepare("UPDATE user_documents SET document_json=? WHERE user_id=? AND kind='dashboard'")
          .bind(
            encodeJson({
              title: "Sin movimientos",
              layout: {
                kind: "leaf",
                widget: {
                  id: "30000000-0000-4000-8000-000000000001",
                  type: "transaction-list",
                  limit: 1,
                },
              },
            }),
            userId
          ),
      ])
    );
    expect(
      yield* io(() =>
        fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
      )
    ).toMatchObject({
      response: {
        status: 200,
        body: { data: { layout: { widget: { result: { transactions: [] } } } } },
      },
    });
    expect(
      yield* io(() =>
        fixture.db
          .prepare("SELECT count(*) AS count FROM commercial_allowance_consumptions")
          .first()
      )
    ).toEqual({ count: 0 });
    yield* io(() =>
      fixture.db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','hosted-withdrawal',?,'hosted-processing',?,?)"
        )
        .bind(userId, sessionId, fixture.current + 1)
        .run()
    );
    expect(
      (yield* io(() =>
        fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
      )).response.status
    ).not.toBe(200);
  })
);

it.live(
  "rechecks the WhatsApp association and exact channel Turn while retaining Hosted Audit attribution",
  () =>
    Effect.gen(function* () {
      const fixture = yield* hostedSnapshotFixture;
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare(
              "UPDATE users SET whatsapp_portfolio_id='portfolio-1',whatsapp_bsuid='CO.Native1',whatsapp_verified_at_ms=1 WHERE id=?"
            )
            .bind(userId),
          fixture.db
            .prepare(
              "UPDATE hosted_turns SET inbound_portfolio_id='portfolio-1',inbound_bsuid='CO.Native1',inbound_message_id='wamid.native',inbound_business_phone_number_id='phone-1',inbound_occurred_at_ms=?,inbound_received_at_ms=? WHERE id=?"
            )
            .bind(fixture.current, fixture.current, fixture.admission.turnId),
        ])
      );
      const admission = yield* Schema.decodeEffect(HostedDashboardAdmission)({
        ...fixture.admission,
        subject: {
          _tag: "WhatsAppHosted",
          userId,
          portfolioId: "portfolio-1",
          bsuid: "CO.Native1",
        },
      });
      expect(
        yield* io(() => fixture.snapshot({ mode: "hosted", admission, request: request() }))
      ).toMatchObject({ response: { status: 200 } });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT session_id,hosted_turn_id,outcome FROM audit_entries").all()
        )
      ).toMatchObject({
        results: [{ session_id: null, hosted_turn_id: admission.turnId, outcome: "accepted" }],
      });
      yield* io(() =>
        fixture.db
          .prepare("UPDATE users SET whatsapp_bsuid='CO.Native2' WHERE id=?")
          .bind(userId)
          .run()
      );
      expect(
        yield* io(() => fixture.snapshot({ mode: "hosted", admission, request: request() }))
      ).toMatchObject({ response: { status: 401 } });
      expect(
        yield* io(() =>
          fixture.snapshot({ mode: "hosted", admission: fixture.admission, request: request() })
        )
      ).toMatchObject({ response: { status: 401 } });
    })
);
