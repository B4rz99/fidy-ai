import { it } from "@effect/vitest";
import { type Cause, Effect, Result, Schema } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";

const moduleText = (): Promise<string> =>
  Bun.build({
    entrypoints: [
      new URL("./sqlite-engine-proof-worker.test-fixture.ts", import.meta.url).pathname,
    ],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  }).then((result) => {
    const output = result.outputs[0];
    if (!result.success || output === undefined) {
      throw new Error("SQLite engine proof build failed");
    }
    return output.text();
  });
const setup = Effect.gen(function* () {
  const module = yield* Effect.tryPromise(moduleText);
  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          workers: [
            {
              config: {
                name: "dashboard-engine-proof",
                type: "worker",
                compatibilityDate: "2026-09-08",
                exports: { DashboardEngineProof: { type: "durable-object", storage: "sqlite" } },
                env: {
                  PROOF: {
                    type: "durable-object",
                    worker: "dashboard-engine-proof",
                    exportName: "DashboardEngineProof",
                  },
                },
                manifest: {
                  mainModule: "index.mjs",
                  modules: { "index.mjs": { type: "esm", contents: module } },
                },
              },
            },
          ],
        })
    ),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
});
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const proofEvidenceName = (): string => {
  if (Bun.env.DASHBOARD_ENGINE_STRESS === "true") return "dashboard-engine-stress.json";
  if (Bun.env.DASHBOARD_ENGINE_BOUNDARY === "true") return "dashboard-engine-boundary.json";
  return "dashboard-engine-proof.json";
};
const proofSizes = (): ReadonlyArray<number> => {
  const sizes = [500, 10000];
  if (Bun.env.DASHBOARD_ENGINE_BOUNDARY === "true") sizes.push(100000);
  if (Bun.env.DASHBOARD_ENGINE_STRESS === "true") sizes.push(1000000);
  return sizes;
};
const userId = "10000000-0000-4000-8000-000000000001";
const categoryId = "10000000-0000-4000-8000-000000000001";
const current = Date.parse("2026-11-04T18:00:00Z");
const widget = {
  id: "30000000-0000-4000-8000-000000000001",
  type: "custom-metric",
  label: "Gastos",
  period: "this-month",
  aggregation: "sum",
};
const install = (runtime: Miniflare): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise(() =>
      Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
    );
    const statements = source
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter((sql) => sql.length > 0 && !sql.startsWith("PRAGMA "));
    statements.push(
      `INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('${userId}','CO','es-CO','America/Bogota',${current})`
    );
    statements.push(
      `INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard','${userId}','${encodeJson({ title: "Exacto", layout: { kind: "leaf", widget } })}',1)`
    );
    statements.push(
      `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001','${userId}','123456789012345678901234567890.01','COP','outflow','${categoryId}',${current},${current})`
    );
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/install", {
        method: "POST",
        body: encodeJson({ statements }),
      })
    );
    expect(response.status).toBe(204);
  });
const ResponseShape = Schema.Struct({
  data: Schema.Struct({ layout: Schema.Unknown }),
  measurement: Schema.Struct({
    scans: Schema.Int,
    financialRows: Schema.Int,
    workingGroups: Schema.Int,
    promotions: Schema.Int,
    rowsRead: Schema.Int,
  }),
});

it.live("folds authoritative wide Money inside one native SQLite transaction", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    yield* install(runtime);
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/read", {
        method: "POST",
        body: encodeJson({ userId, current, accumulation: "compact" }),
      })
    );
    if (response.status !== 200) throw new Error(yield* Effect.tryPromise(() => response.text()));
    expect(response.status).toBe(200);
    const value = yield* Schema.decodeUnknownEffect(ResponseShape)(
      yield* Effect.tryPromise(() => response.json())
    );
    expect(value.measurement).toMatchObject({
      scans: 1,
      financialRows: 1,
      workingGroups: 1,
      promotions: 1,
    });
    expect(value.data.layout).toMatchObject({
      kind: "leaf",
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
    });
  })
);

it.live(
  "shares overlapping chart and metric scans while preserving bounded lists and current Budget caps",
  () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      yield* install(runtime);
      const widgets = [
        widget,
        { ...widget, id: "30000000-0000-4000-8000-000000000002", aggregation: "maximum" },
        {
          id: "30000000-0000-4000-8000-000000000003",
          type: "spending-chart",
          groupBy: "day",
          period: "this-month",
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
          limit: 1,
          categories: [categoryId],
          search: "café",
        },
      ];
      const document = {
        title: "Todos",
        layout: {
          kind: "split",
          axis: "row",
          children: widgets.map((item) => ({ weight: 1, node: { kind: "leaf", widget: item } })),
        },
      };
      const statements = [
        `DELETE FROM transactions WHERE user_id='${userId}'`,
        `UPDATE user_documents SET document_json='${encodeJson(document)}' WHERE user_id='${userId}'`,
        `INSERT INTO budgets(id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms) VALUES ('50000000-0000-4000-8000-000000000001','${userId}','${categoryId}','COP','100',${current},${current})`,
        `INSERT INTO budget_month_plan_records(kind,user_id,month,budget_id,cap) VALUES ('cap','${userId}','2026-11','50000000-0000-4000-8000-000000000001','100')`,
        `INSERT INTO budget_month_plan_records(kind,user_id,month,budget_id,cap) VALUES ('cap','${userId}','2026-12','50000000-0000-4000-8000-000000000001','200')`,
        ...["10", "2.02"].map(
          (amount, index) =>
            `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-00000000000${index + 2}','${userId}','${amount}','COP','outflow','${categoryId}',${current + index},${current})`
        ),
        `UPDATE transactions SET counterparty='CAFÉ' WHERE user_id='${userId}'`,
      ];
      expect(
        (yield* Effect.tryPromise(() =>
          runtime.dispatchFetch("https://proof.internal/install", {
            method: "POST",
            body: encodeJson({ statements }),
          })
        )).status
      ).toBe(204);
      const reply = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/read", {
          method: "POST",
          body: encodeJson({ userId, current, accumulation: "compact" }),
        })
      );
      expect(reply.status).toBe(200);
      const value = yield* Effect.tryPromise(() => reply.json());
      expect(value).toMatchObject({
        measurement: { scans: 1, financialRows: 2, workingGroups: 1 },
        data: {
          layout: {
            children: [
              {
                node: {
                  widget: {
                    result: { moneyGroups: [{ currency: "COP", outflow: { amount: "12.02" } }] },
                  },
                },
              },
              {
                node: {
                  widget: {
                    result: { moneyGroups: [{ currency: "COP", outflow: { amount: "10" } }] },
                  },
                },
              },
              {
                node: {
                  widget: {
                    result: {
                      buckets: [
                        {
                          key: { kind: "day", date: "2026-11-04" },
                          moneyGroups: [{ currency: "COP", outflow: { amount: "12.02" } }],
                        },
                      ],
                    },
                  },
                },
              },
              {
                node: {
                  widget: {
                    result: {
                      availability: "available",
                      cap: { amount: "100", currency: "COP" },
                      spent: { amount: "12.02", currency: "COP" },
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
                          money: { amount: "2.02", currency: "COP" },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      });
    })
);

it.live("uses the stored current IANA timezone across the repeated DST hour", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    yield* install(runtime);
    const dstCurrent = Date.parse("2026-11-02T12:00:00Z");
    const chart = { id: widget.id, type: "spending-chart", groupBy: "day", period: "last-7-days" };
    const statements = [
      `DELETE FROM transactions WHERE user_id='${userId}'`,
      `UPDATE users SET time_zone='America/New_York' WHERE id='${userId}'`,
      `UPDATE user_documents SET document_json='${encodeJson({ title: "Días", layout: { kind: "leaf", widget: chart } })}' WHERE user_id='${userId}'`,
      ...["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T03:59:00Z"].map(
        (instant, index) =>
          `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-00000000000${index + 2}','${userId}','${index + 1}','COP','outflow','${categoryId}',${Date.parse(instant)},${dstCurrent})`
      ),
    ];
    expect(
      (yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/install", {
          method: "POST",
          body: encodeJson({ statements }),
        })
      )).status
    ).toBe(204);
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/read", {
        method: "POST",
        body: encodeJson({ userId, current: dstCurrent, accumulation: "compact" }),
      })
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
      data: {
        context: { timeZone: "America/New_York" },
        layout: {
          widget: {
            result: {
              buckets: [
                {
                  key: { kind: "day", date: "2026-10-31" },
                  moneyGroups: [{ outflow: { amount: "3" } }],
                },
                {
                  key: { kind: "day", date: "2026-11-01" },
                  moneyGroups: [{ outflow: { amount: "3" } }],
                },
              ],
            },
          },
        },
      },
    });
  })
);

it.live(
  "uses the same corrected effective movement in lists and complete totals after Reconciliation",
  () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      yield* install(runtime);
      const first = "40000000-0000-4000-8000-000000000002";
      const second = "40000000-0000-4000-8000-000000000003";
      const document = {
        title: "Conciliado",
        layout: {
          kind: "split",
          axis: "row",
          children: [
            widget,
            { id: "30000000-0000-4000-8000-000000000002", type: "transaction-list", limit: 5 },
          ].map((item) => ({ weight: 1, node: { kind: "leaf", widget: item } })),
        },
      };
      const statements = [
        `DELETE FROM transactions WHERE user_id='${userId}'`,
        `UPDATE user_documents SET document_json='${encodeJson(document)}' WHERE user_id='${userId}'`,
        ...[first, second].map(
          (id) =>
            `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES ('${id}','${userId}','10','COP','outflow','${categoryId}','Original',${current},${current})`
        ),
        `INSERT INTO transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms) VALUES ('${userId}','${first}','${second}','linked','${first}',${current})`,
        `UPDATE transactions SET reconciliation_first_id='${first}',reconciliation_second_id='${second}' WHERE id IN ('${first}','${second}')`,
        `UPDATE transactions SET counterparty='Decisión explícita',user_decisions='{"counterparty":true}' WHERE id='${second}'`,
      ];
      expect(
        (yield* Effect.tryPromise(() =>
          runtime.dispatchFetch("https://proof.internal/install", {
            method: "POST",
            body: encodeJson({ statements }),
          })
        )).status
      ).toBe(204);
      const read = (): ReturnType<Miniflare["dispatchFetch"]> =>
        runtime.dispatchFetch("https://proof.internal/read", {
          method: "POST",
          body: encodeJson({ userId, current, accumulation: "compact" }),
        });
      const before = yield* Effect.tryPromise(read);
      expect(before.status).toBe(200);
      expect(yield* Effect.tryPromise(() => before.json())).toMatchObject({
        measurement: { financialRows: 1 },
        data: {
          layout: {
            children: [
              { node: { widget: { result: { moneyGroups: [{ outflow: { amount: "10" } }] } } } },
              {
                node: {
                  widget: {
                    result: {
                      transactions: [
                        { id: first, counterparty: "Decisión explícita", money: { amount: "10" } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      });
      const correction = [
        `INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','${userId}','${first}',0,'["money"]','{}','{}',${current})`,
        `UPDATE transactions SET amount='15.01',revision=revision+1 WHERE id='${first}'`,
      ];
      const corrected = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/install", {
          method: "POST",
          body: encodeJson({ statements: correction }),
        })
      );
      if (corrected.status !== 204) {
        throw new Error(yield* Effect.tryPromise(() => corrected.text()));
      }
      expect(corrected.status).toBe(204);
      const after = yield* Effect.tryPromise(read);
      expect(after.status).toBe(200);
      expect(yield* Effect.tryPromise(() => after.json())).toMatchObject({
        data: {
          layout: {
            children: [
              { node: { widget: { result: { moneyGroups: [{ outflow: { amount: "15.01" } }] } } } },
              {
                node: {
                  widget: {
                    result: {
                      transactions: [
                        {
                          id: first,
                          counterparty: "Decisión explícita",
                          money: { amount: "15.01" },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      });
    })
);

it.live(
  "keeps cursor working groups bounded for dense distinct amounts and compares exact accumulation strategies",
  () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      yield* install(runtime);
      const layout = {
        title: "Máximo",
        layout: {
          kind: "split",
          axis: "row",
          children: Array.from({ length: 24 }, (_, index) => ({
            weight: 1,
            node: {
              kind: "leaf",
              widget: {
                ...widget,
                id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              },
            },
          })),
        },
      };
      const cohorts: Array<Schema.Json> = [];
      const evidenceName = proofEvidenceName();
      const evidencePath = new URL(`../../test-results/${evidenceName}`, import.meta.url);
      const persistEvidence = (): Effect.Effect<number, Cause.UnknownError> =>
        Effect.tryPromise(() =>
          Bun.write(
            evidencePath,
            encodeJson({
              engine: "native SQLite Durable Object",
              measurement:
                "exploratory host monotonic complete local RPC and render; no production or D1 comparison claim",
              cohorts,
            })
          )
        );
      const sizes = proofSizes();
      const expectedAmounts = new Map([
        [500, "125255"],
        [10000, "50005100"],
        [100000, "5000051000"],
        [1000000, "500000510000"],
      ]);
      for (const count of sizes) {
        cohorts.push({ count, outcome: "seed_started" });
        yield* persistEvidence();
        const statements = [
          `DELETE FROM transactions WHERE user_id='${userId}'`,
          `UPDATE user_documents SET document_json='${encodeJson(layout)}' WHERE user_id='${userId}'`,
          `WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<${count}) INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT printf('40000000-0000-4000-8000-%012d',n),'${userId}',CAST(n AS TEXT)||'.01','COP','outflow','${categoryId}',${current},${current} FROM fixture`,
        ];
        expect(
          (yield* Effect.tryPromise(() =>
            runtime.dispatchFetch("https://proof.internal/install", {
              method: "POST",
              body: encodeJson({ statements }),
            })
          )).status
        ).toBe(204);
        const values: Array<unknown> = [];
        for (const [sample, accumulation] of [
          "compact",
          "bigint",
          "bigint",
          "compact",
          "compact",
          "bigint",
        ].entries()) {
          const started = performance.now();
          const selected = yield* Effect.result(
            Effect.tryPromise(() =>
              runtime.dispatchFetch("https://proof.internal/read", {
                method: "POST",
                body: encodeJson({ userId, current, accumulation }),
              })
            )
          );
          if (Result.isFailure(selected)) {
            cohorts.push({
              count,
              accumulation,
              sample,
              outcome: "transport_failed",
              elapsed: performance.now() - started,
            });
            yield* persistEvidence();
            return yield* selected.failure;
          }
          const response = selected.success;
          if (response.status !== 200) {
            cohorts.push({
              count,
              accumulation,
              sample,
              outcome: "refused",
              status: response.status,
              elapsed: performance.now() - started,
            });
            yield* persistEvidence();
          }
          expect(response.status).toBe(200);
          const value = yield* Effect.tryPromise(() => response.json());
          const elapsed = performance.now() - started;
          const decoded = yield* Schema.decodeUnknownEffect(ResponseShape)(value);
          expect(decoded.measurement).toMatchObject({
            scans: 1,
            financialRows: count,
            workingGroups: 1,
          });
          expect(decoded.data.layout).toMatchObject({
            children: [
              {
                node: {
                  widget: {
                    result: {
                      moneyGroups: [{ outflow: { amount: expectedAmounts.get(count) } }],
                    },
                  },
                },
              },
              ...Array.from({ length: 23 }, () => ({})),
            ],
          });
          values.push(decoded.data);
          cohorts.push({
            count,
            accumulation,
            sample,
            warmup: sample < 2,
            elapsed,
            measurement: decoded.measurement,
          });
          yield* persistEvidence();
        }
        expect(values[0]).toEqual(values[1]);
      }
      const timerStart = performance.now();
      let previous = timerStart;
      let resolution = Infinity;
      for (let index = 0; index < 10000; index++) {
        const next = performance.now();
        if (next > previous) resolution = Math.min(resolution, next - previous);
        previous = next;
      }
      const timerOverhead = (performance.now() - timerStart) / 10000;
      yield* Effect.tryPromise(() =>
        Bun.write(
          evidencePath,
          encodeJson({
            timer: { resolutionMilliseconds: resolution, overheadMilliseconds: timerOverhead },
            engine: "native SQLite Durable Object",
            measurement:
              "host monotonic full local RPC; includes rendering; no production latency claim",
            cohorts,
          })
        )
      );
    }),
  { timeout: 300000 }
);

it.live(
  "rolls back the enclosing native transaction when the retained Dashboard cannot be validated",
  () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      yield* install(runtime);
      expect(
        (yield* Effect.tryPromise(() =>
          runtime.dispatchFetch("https://proof.internal/install", {
            method: "POST",
            body: encodeJson({
              statements: [
                `UPDATE user_documents SET document_json='{}' WHERE user_id='${userId}'`,
              ],
            }),
          })
        )).status
      ).toBe(204);
      const response = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/read", {
          method: "POST",
          body: encodeJson({ userId, current, accumulation: "compact" }),
        })
      );
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.text())).toBe("");
      const receipt = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/receipts")
      );
      expect(yield* Effect.tryPromise(() => receipt.json())).toEqual({ count: 0 });
    })
);

it.live("promotes a compact sum without rounding counts, maxima or Currency-separated Money", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    yield* install(runtime);
    const widgets = [
      widget,
      { ...widget, id: "30000000-0000-4000-8000-000000000002", aggregation: "average" },
      { ...widget, id: "30000000-0000-4000-8000-000000000003", aggregation: "maximum" },
    ];
    const document = {
      title: "Promoción",
      layout: {
        kind: "split",
        axis: "row",
        children: widgets.map((item) => ({ weight: 1, node: { kind: "leaf", widget: item } })),
      },
    };
    const statements = [
      `DELETE FROM transactions WHERE user_id='${userId}'`,
      `UPDATE user_documents SET document_json='${encodeJson(document)}' WHERE user_id='${userId}'`,
      `WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<10) INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT printf('40000000-0000-4000-8000-%012d',n),'${userId}','99999999999.99','COP','outflow','${categoryId}',${current},${current} FROM fixture`,
      `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000011','${userId}','2.01','USD','outflow','${categoryId}',${current},${current})`,
    ];
    expect(
      (yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/install", {
          method: "POST",
          body: encodeJson({ statements }),
        })
      )).status
    ).toBe(204);
    const responses: Array<unknown> = [];
    for (const accumulation of ["compact", "bigint"]) {
      const response = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/read", {
          method: "POST",
          body: encodeJson({ userId, current, accumulation }),
        })
      );
      expect(response.status).toBe(200);
      const value = yield* Effect.tryPromise(() => response.json());
      const decoded = yield* Schema.decodeUnknownEffect(ResponseShape)(value);
      expect(decoded.measurement).toMatchObject({ scans: 1, financialRows: 11, workingGroups: 2 });
      expect(decoded.data.layout).toMatchObject({
        children: [
          {
            node: {
              widget: {
                result: {
                  moneyGroups: [
                    { currency: "COP", outflow: { amount: "999999999999.9" } },
                    { currency: "USD", outflow: { amount: "2.01" } },
                  ],
                },
              },
            },
          },
          {
            node: {
              widget: {
                result: {
                  moneyGroups: [
                    { currency: "COP", outflow: { amount: "99999999999.99" } },
                    { currency: "USD", outflow: { amount: "2.01" } },
                  ],
                },
              },
            },
          },
          {
            node: {
              widget: {
                result: {
                  moneyGroups: [
                    { currency: "COP", outflow: { amount: "99999999999.99" } },
                    { currency: "USD", outflow: { amount: "2.01" } },
                  ],
                },
              },
            },
          },
        ],
      });
      responses.push(decoded.data);
    }
    expect(responses[0]).toEqual(responses[1]);
  })
);

it.live("scans each disjoint requested span once and excludes the gap from financial work", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    yield* install(runtime);
    const later = Date.parse("2026-11-25T12:00:00Z");
    const widgets = [
      { ...widget, period: "this-week" },
      { ...widget, id: "30000000-0000-4000-8000-000000000002", period: "last-month" },
    ];
    const document = {
      title: "Periodos",
      layout: {
        kind: "split",
        axis: "row",
        children: widgets.map((item) => ({ weight: 1, node: { kind: "leaf", widget: item } })),
      },
    };
    const statements = [
      `DELETE FROM transactions WHERE user_id='${userId}'`,
      `UPDATE user_documents SET document_json='${encodeJson(document)}' WHERE user_id='${userId}'`,
      ...[
        { amount: "10", instant: "2026-10-05T12:00:00Z" },
        { amount: "20", instant: "2026-11-24T12:00:00Z" },
        { amount: "999", instant: "2026-11-10T12:00:00Z" },
      ].map(
        (fact, index) =>
          `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-00000000000${index + 2}','${userId}','${fact.amount}','COP','outflow','${categoryId}',${Date.parse(fact.instant)},${later})`
      ),
    ];
    expect(
      (yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/install", {
          method: "POST",
          body: encodeJson({ statements }),
        })
      )).status
    ).toBe(204);
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/read", {
        method: "POST",
        body: encodeJson({ userId, current: later, accumulation: "compact" }),
      })
    );
    expect(response.status).toBe(200);
    const value = yield* Effect.tryPromise(() => response.json());
    expect(value).toMatchObject({
      measurement: { scans: 2, financialRows: 2, workingGroups: 2 },
      data: {
        layout: {
          children: [
            { node: { widget: { result: { moneyGroups: [{ outflow: { amount: "20" } }] } } } },
            { node: { widget: { result: { moneyGroups: [{ outflow: { amount: "10" } }] } } } },
          ],
        },
      },
    });
  })
);
