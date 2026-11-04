import { it } from "@effect/vitest";
import { type Cause, DateTime, Effect, Schema } from "effect";
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
      ).toEqual({ kind: "refused", status: 503 });
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
