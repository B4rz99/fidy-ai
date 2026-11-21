import type { MoneyGroups } from "../../src/core/_shared/money";
import { canonicalRequestProtection } from "../canonical-admission/contract";
import { resolveDashboardPeriod } from "../../src/core/dashboard/operations";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { DashboardDocument } from "../../src/core/dashboard/contract";
import { Transaction } from "../../src/core/transactions/contract";
import { DashboardView } from "../../src/shell/dashboard/contract";
import { assertListSelection, listIds, metricTotals } from "./view.test-fixture";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  BigDecimal,
  type Cause,
  DateTime,
  Effect,
  type FileSystem,
  Option,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { expect, it as scenario } from "vitest";
import { native, nativeCapacityPlatform } from "../user-store.test-fixture";
import {
  alice,
  bob,
  makeNativeTransactionJourney,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("withholds the absent Dashboard and initializes it in the owning User store", () =>
    Effect.gen(function* () {
      const owner = yield* nativeTransactionJourney;
      const absent = yield* native(() => owner.browser(0, "/dashboard/view"));
      expect(absent.status).toBe(404);
      expect(yield* native(() => absent.json())).toMatchObject({
        error: { code: "dashboard_uninitialized" },
      });

      const initialized = yield* native(() =>
        owner.send(
          new Request("https://api.fidyapp.com/dashboard/initialize", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": alice.session,
              cookie: "__Host-fidy_session=" + alice.bearer,
              "content-type": "application/json",
            },
            body: "{}",
          })
        )
      );

      expect(initialized.status).toBe(200);
      expect((yield* native(() => owner.browser(0, "/dashboard/view"))).status).toBe(200);
      expect((yield* native(() => owner.browser(1, "/dashboard/view"))).status).toBe(404);
    })
  );
});

type Journey = Effect.Success<typeof nativeTransactionJourney>;

const runNative = <A, E>(
  work: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>
): Promise<A> => Effect.runPromise(work.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

const setup = (): typeof nativeTransactionJourney => nativeTransactionJourney;

type DashboardCall =
  | string
  | Readonly<{ path: string; method: "POST" | "PUT"; body: Schema.Json }>
  | Readonly<{ path: string; method: "DELETE" }>;

const send = (store: Journey, index: number, call: DashboardCall): Promise<Response> =>
  Bun.sleep(canonicalRequestProtection.intervalMs).then(() => {
    if (Predicate.isString(call)) return store.browser(index, call);
    const subject = index === 0 ? alice : bob;

    const init = {
      method: call.method,
      headers: {
        origin: "https://app.fidyapp.com",
        "Fidy-Session-Binding": subject.session,
        cookie: "__Host-fidy_session=" + subject.bearer,
        "content-type": "application/json",
      },
    };

    return store.send(
      new Request(
        "https://api.fidyapp.com" + call.path,
        "body" in call ? { ...init, body: JSON.stringify(call.body) } : init
      )
    );
  });

type ScopedCall = (path: string, body?: Schema.Json) => Effect.Effect<Response>;

type DashboardScope = "read" | "write" | "dashboard";

const scopedCall =
  (owner: Journey, token: string): ScopedCall =>
  (path, body) => {
    const headers = {
      authorization: "Bearer " + token,
      "cf-connecting-ip": "192.0.2.35",
      "content-type": "application/json",
    };

    return native(() =>
      owner.send(
        new Request(
          "https://api.fidyapp.com" + path,
          body === undefined
            ? { method: "GET", headers }
            : { method: "POST", headers, body: JSON.stringify(body) }
        )
      )
    );
  };

const uninitializedRead = Effect.fn(function* (call: ScopedCall, path: string) {
  const response = yield* call(path);
  expect(response.status).toBe(404);
  expect(yield* native(() => response.json())).toMatchObject({
    error: { code: "dashboard_uninitialized" },
  });
});

const deniedInitialization = Effect.fn(function* (call: ScopedCall, owner: Journey) {
  expect((yield* call("/dashboard/initialize", {})).status).toBe(403);
  expect(yield* native(() => owner.exec("SELECT count(*) AS docs FROM user_documents"))).toEqual([
    { docs: 0 },
  ]);
});

const readScopeObservation = Effect.fn(function* (call: ScopedCall, owner: Journey) {
  yield* Effect.forEach(
    ["/dashboard", "/dashboard/view"],
    (path) => uninitializedRead(call, path),
    {
      discard: true,
    }
  );
  expect((yield* call("/dashboard/edits", { op: "set-title", title: "Denied" })).status).toBe(403);
  yield* deniedInitialization(call, owner);
});

const dashboardScopeObservation = Effect.fn(function* (call: ScopedCall) {
  expect(
    (yield* call("/transactions", {
      money: { currency: "COP", amount: "2" },
      direction: "outflow",
      occurredAt: "2025-01-01T00:00:00Z",
    })).status
  ).toBe(403);
  expect((yield* call("/dashboard/initialize", {})).status).toBe(200);
});

const scopeObservations = {
  read: readScopeObservation,
  write: deniedInitialization,
  dashboard: dashboardScopeObservation,
};

const verifyDashboardScope = Effect.fn(function* (
  owner: Journey,
  scope: DashboardScope,
  index: number
) {
  const token = "fin_dbscope" + index + "_" + "x".repeat(43);
  yield* seedNativePAT({
    db: owner,
    userId: alice.user,
    token,
    scopes: [scope],
    current: DateTime.nowUnsafe().epochMilliseconds,
  });
  yield* scopeObservations[scope](scopedCall(owner, token), owner);
});

const expectReplay = Effect.fn(function* ([retry, response]: readonly [
  () => Effect.Effect<Response>,
  Response,
]) {
  const replay = yield* retry();
  expect(replay.status).toBe(200);
  expect(yield* native(() => replay.text())).toBe(yield* native(() => response.text()));
});

const initialize = (store: Journey, index = 0): Promise<Response> =>
  send(store, index, { path: "/dashboard/initialize", method: "POST", body: {} });

const initializedSetup = (): typeof nativeTransactionJourney =>
  Effect.gen(function* () {
    const owner = yield* setup();
    expect((yield* native(() => initialize(owner))).status).toBe(200);

    return owner;
  });

scenario(
  "finds a recent Transaction by its captured notes in a configured list Widget",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* setup();
        const documentResponse10 = yield* Effect.tryPromise(() => initialize(db));

        const document = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse10.json()))).data;

        const leaves = (
          node: DashboardDocument["layout"]
        ): ReadonlyArray<DashboardDocument["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));

        const list = leaves(document.layout).find(
          (node) => node.kind === "leaf" && node.widget.type === "transaction-list"
        );

        if (list?.kind !== "leaf" || list.widget.type !== "transaction-list") {
          throw new Error("Missing list");
        }

        const edited = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "update-widget",
              widget: { ...list.widget, search: "private note" },
            },
          })
        );

        expect(edited.status).toBe(200);

        const created = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "1.01", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
              notes: "private note Café",
            },
          })
        );

        expect(created.status).toBe(201);
        const viewResponse11 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));

        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => viewResponse11.json()))).data;

        const viewLeaves = (
          node: DashboardView["layout"]
        ): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => viewLeaves(child.node));

        const row = viewLeaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.id === list.widget.id
        );

        if (row?.kind !== "leaf" || !("transactions" in row.widget.result)) {
          throw new Error("Missing list result");
        }

        expect(row.widget.result.transactions).toHaveLength(1);

        const accented = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "CAFÉ" } },
          })
        );

        expect(accented.status).toBe(200);
        const viewResponse12 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse12, list.widget.id)).toHaveLength(1);

        const twoCharacters = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "fé" } },
          })
        );

        expect(twoCharacters.status).toBe(200);
        const viewResponse13 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse13, list.widget.id)).toHaveLength(1);

        const oneCharacter = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "é" } },
          })
        );

        expect(oneCharacter.status).toBe(200);
        const viewResponse14 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse14, list.widget.id)).toHaveLength(1);

        const captured = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ id: Transaction.fields.id }),
          })
        )(yield* Effect.tryPromise(() => created.json()))).data;

        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: `/transactions/${captured.id}`,
              method: "PUT",
              body: { expectedRevision: 0, changes: { notes: "unrelated" } },
            })
          )).status
        ).toBe(200);
        const viewResponse15 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse15, list.widget.id)).toEqual([]);
      })
    ),
  30_000
);

scenario(
  "projects the current User's Budget with exact outflow spend and remaining Money",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* initializedSetup();

        const budget = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/budgets",
            method: "POST",
            body: {
              categoryId: "10000000-0000-4000-8000-000000000001",
              cap: { amount: "100.00", currency: "COP" },
            },
          })
        );

        expect(budget.status).toBe(201);

        const captured = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "25.02", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          })
        );

        expect(captured.status).toBe(201);
        const viewResponse = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(viewResponse.status).toBe(200);

        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => viewResponse.json()))).data;

        const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));

        const bar = leaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.type === "budget-bar"
        );

        if (
          bar?.kind !== "leaf" ||
          !("availability" in bar.widget.result) ||
          bar.widget.result.availability !== "available"
        ) {
          throw new Error("Missing Budget bar");
        }

        expect(BigDecimal.format(bar.widget.result.spent.amount)).toBe("25.02");

        if (bar.widget.result.status.type !== "under") throw new Error("Expected remaining Budget");
        expect(BigDecimal.format(bar.widget.result.status.remaining.amount)).toBe("74.98");
      })
    ),
  30_000
);

scenario(
  "a stale Dashboard read is replaced by current canonical facts after a Transaction correction",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* initializedSetup();

        const created = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "10.01", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          })
        );

        expect(created.status).toBe(201);

        const { data: transaction } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
        )(yield* Effect.tryPromise(() => created.json()));

        const before = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(before.status).toBe(200);

        const correction = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: `/transactions/${transaction.id}`,
            method: "PUT",
            body: { expectedRevision: 0, changes: { money: { amount: "25.02", currency: "COP" } } },
          })
        );

        expect(correction.status).toBe(200);
        const after = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(after.status).toBe(200);

        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => after.json()))).data;

        const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));

        const metric = leaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
        );

        expect(metric?.kind).toBe("leaf");

        if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
          throw new Error("Expected metric");
        }

        expect(
          metric.widget.result.moneyGroups.map((group) => BigDecimal.format(group.outflow.amount))
        ).toEqual(["25.02"]);
      })
    ),
  30_000
);

scenario(
  "reinterprets maintained UTC contributions immediately after a User IANA time-zone change",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const now = DateTime.nowUnsafe();

        const zones = (yield* Effect.forEach(["Pacific/Kiritimati", "America/Bogota"], (name) =>
          Effect.map(Schema.decodeEffect(IanaTimeZone)(name), (timeZone) => ({
            name,
            from: resolveDashboardPeriod({ now, period: "this-month", timeZone }).from
              .epochMilliseconds,
          }))
        )).sort((left, right) => left.from - right.from);

        const earlier = zones[0];
        const later = zones[1];

        if (earlier === undefined || later === undefined || earlier.from === later.from) {
          throw new Error("Expected distinct IANA month boundaries");
        }

        const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(earlier.from + 60_000));
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/transactions",
              method: "POST",
              body: {
                money: { amount: "3.04", currency: "COP" },
                categoryId: "10000000-0000-4000-8000-000000000001",
                direction: "outflow",
                occurredAt,
              },
            })
          )).status
        ).toBe(201);

        const projected = (
          zone: string
        ): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              db.exec("UPDATE users SET time_zone = ? WHERE id = ?", zone, alice.user)
            );

            return yield* metricTotals(
              yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))
            );
          });

        expect(yield* projected(earlier.name)).toEqual(["3.04"]);
        expect(yield* projected(later.name)).toEqual([]);
        expect(yield* projected(earlier.name)).toEqual(["3.04"]);
      })
    ),
  30_000
);

scenario(
  "updates the next Dashboard view after linking, correcting, and unlinking effective Transactions",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* initializedSetup();

        const responses = yield* Effect.forEach([0, 1], () =>
          Effect.tryPromise(() =>
            send(db, 0, {
              path: "/transactions",
              method: "POST",
              body: {
                money: { amount: "9007199254740993.01", currency: "COP" },
                categoryId: "10000000-0000-4000-8000-000000000001",
                direction: "outflow",
                occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
              },
            })
          )
        );

        expect(responses.map((response) => response.status)).toEqual([201, 201]);

        const bodies = yield* Effect.tryPromise(() =>
          Promise.all(responses.map((response) => response.json()))
        );

        const ids = yield* Effect.forEach(bodies, (body) =>
          Effect.map(
            Schema.decodeUnknownEffect(
              Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
            )(body),
            (decoded) => decoded.data.id
          )
        );

        const first = [...ids].sort()[0];
        const second = [...ids].sort()[1];

        if (first === undefined || second === undefined) throw new Error("Missing Transactions");

        const total = (): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError> =>
          Effect.gen(function* () {
            return (yield* metricTotals(
              yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))
            )).join(",");
          });

        expect(yield* total()).toBe("18014398509481986.02");
        const pair = { firstTransactionId: first, secondTransactionId: second };
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/transactions/link", method: "POST", body: pair })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("9007199254740993.01");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: `/transactions/${first}`,
              method: "PUT",
              body: {
                expectedRevision: 0,
                changes: { money: { amount: "9007199254740993.02", currency: "COP" } },
              },
            })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("9007199254740993.02");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/transactions/unlink", method: "POST", body: pair })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("18014398509481986.03");
      })
    ),
  30_000
);

scenario(
  "reads newly committed Transactions as exact separate Currency groups without another User's facts",
  () =>
    runNative(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());

        const capture = (index: number, amount: string, currency: string): Promise<Response> =>
          send(db, index, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount, currency },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt,
            },
          });

        expect((yield* Effect.tryPromise(() => capture(0, "1.01", "COP"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(0, "2.02", "COP"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(0, "5.50", "USD"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(1, "999", "COP"))).status).toBe(201);
        const reply = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(reply.status).toBe(200);

        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => reply.json()));

        const leaves = (
          node: DashboardView["layout"]
        ): ReadonlyArray<Extract<DashboardView["layout"], { kind: "leaf" }>["widget"]> =>
          node.kind === "leaf"
            ? [node.widget]
            : node.children.flatMap((child) => leaves(child.node));

        const metric = leaves(body.data.layout).find(
          (leaf) => leaf.widget.type === "custom-metric"
        );

        if (metric === undefined || !("moneyGroups" in metric.result)) {
          throw new Error("Expected a custom metric");
        }

        expect(
          metric.result.moneyGroups.map((group) => [
            group.currency,
            BigDecimal.format(group.outflow.amount),
          ])
        ).toEqual([
          ["COP", "3.03"],
          ["USD", "5.5"],
        ]);
      })
    ),
  30_000
);

const viewWidgets = (
  node: DashboardView["layout"]
): ReadonlyArray<Extract<DashboardView["layout"], { kind: "leaf" }>["widget"]> =>
  node.kind === "leaf" ? [node.widget] : node.children.flatMap((child) => viewWidgets(child.node));

const fetchView = Effect.fn(function* (store: Journey, path: string = "/dashboard/view") {
  const response = yield* native(() => send(store, 0, path));
  expect(response.status).toBe(200);

  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
  )(yield* native(() => response.json()));

  return viewWidgets(body.data.layout);
});

const metricGroups = (widget: ReturnType<typeof viewWidgets>[number]): MoneyGroups => {
  if (!("moneyGroups" in widget.result)) throw new Error("Missing metric");

  return widget.result.moneyGroups;
};

scenario(
  "reads complete mixed-Currency groups and counts across a page and the exact local month boundary",
  () =>
    runNative(
      Effect.gen(function* () {
        const store = yield* setup();
        const restaurants = "10000000-0000-4000-8000-000000000001";
        const groceries = "10000000-0000-4000-8000-000000000012";

        const from = resolveDashboardPeriod({
          now: DateTime.nowUnsafe(),
          timeZone: IanaTimeZone.make("America/Bogota"),
          period: "this-month",
        }).from.epochMilliseconds;

        const widgets = [
          { type: "spending-chart", period: "this-month", groupBy: "category" },
          {
            type: "custom-metric",
            aggregation: "average",
            label: "Promedio",
            period: "this-month",
            categories: [restaurants],
          },
          { type: "custom-metric", aggregation: "maximum", label: "Máximo", period: "this-month" },
          { type: "transaction-list", limit: 2 },
        ];

        const doc = {
          title: "Mes",
          layout: {
            kind: "split",
            axis: "column",
            children: widgets.map((widget, index) => ({
              weight: 1,
              node: {
                kind: "leaf",
                widget: { ...widget, id: "77700000-0000-4000-8000-00000000000" + index },
              },
            })),
          },
        };

        yield* native(() =>
          store.exec(
            "INSERT INTO user_documents VALUES (?,'dashboard',?,1)",
            alice.user,
            JSON.stringify(doc)
          )
        );
        yield* native(() =>
          store.exec("INSERT INTO categories VALUES (?,'Restaurantes',3)", restaurants)
        );
        yield* native(() =>
          store.exec(
            `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<125)
    INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms)
    SELECT printf('22220000-0000-4000-8000-%012d',i),?,
    CASE WHEN i<=120 THEN '2' WHEN i=121 THEN '123' WHEN i=122 THEN '9007199254740993.01' WHEN i=123 THEN '0.01' WHEN i=124 THEN '7.77' ELSE '999' END,
    CASE WHEN i IN(122,123) THEN 'USD' ELSE 'COP' END,
    CASE WHEN i=124 THEN 'inflow' ELSE 'outflow' END,
    CASE WHEN i IN(122,123) THEN ? ELSE ? END,CASE WHEN i=125 THEN ?-1 ELSE ? END,? FROM n`,
            alice.user,
            groceries,
            restaurants,
            from,
            from,
            from
          )
        );
        const [chart, average, maximum, list] = yield* fetchView(store);

        if (chart === undefined || !("buckets" in chart.result)) throw new Error("Missing chart");
        const averageGroups = metricGroups(Option.getOrThrow(Option.fromUndefinedOr(average)));
        const maximumGroups = metricGroups(Option.getOrThrow(Option.fromUndefinedOr(maximum)));

        if (list === undefined || !("transactions" in list.result)) throw new Error("Missing list");
        expect(
          chart.result.buckets.map((bucket) => [
            bucket.key.kind === "category" ? bucket.key.category.id : undefined,
            ...bucket.moneyGroups.map((group) => [
              group.currency,
              BigDecimal.format(group.inflow.amount),
              BigDecimal.format(group.outflow.amount),
            ]),
          ])
        ).toEqual([
          [restaurants, ["COP", "7.77", "363"]],
          [groceries, ["USD", "0", "9007199254740993.02"]],
        ]);
        expect(
          averageGroups.map((group) => [
            group.currency,
            BigDecimal.format(group.inflow.amount),
            BigDecimal.format(group.outflow.amount),
          ])
        ).toEqual([["COP", "7.77", "3"]]);
        expect(
          maximumGroups.map((group) => [group.currency, BigDecimal.format(group.outflow.amount)])
        ).toEqual([
          ["COP", "123"],
          ["USD", "9007199254740993.01"],
        ]);
        expect(list.result.transactions).toHaveLength(2);
      })
    ),
  30000
);

scenario(
  "withholds Dashboard facts when accounting cannot commit or the projection is incomplete",
  () =>
    runNative(
      Effect.gen(function* () {
        const store = yield* initializedSetup();

        const before = yield* native(() =>
          store.exec("SELECT count(*) AS audits FROM audit_entries")
        );

        yield* native(() =>
          store.exec(
            "CREATE TRIGGER refuse_dashboard BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.getDashboardView' BEGIN SELECT RAISE(IGNORE); END"
          )
        );
        expect((yield* native(() => send(store, 0, "/dashboard/view"))).status).toBe(503);
        expect(
          yield* native(() => store.exec("SELECT count(*) AS audits FROM audit_entries"))
        ).toEqual(before);
        yield* native(() => store.exec("DROP TRIGGER refuse_dashboard"));
        yield* native(() =>
          store.exec("UPDATE transaction_projection_state SET readiness='dirty'")
        );
        expect((yield* native(() => send(store, 0, "/dashboard/view"))).status).toBe(503);
        expect(
          yield* native(() => store.exec("SELECT count(*) AS audits FROM audit_entries"))
        ).toEqual(before);
        expect((yield* native(() => send(store, 1, "/dashboard/view"))).status).toBe(404);
      })
    ),
  30000
);

scenario(
  "read-only PATs can observe an absent Dashboard while write and dashboard grants remain independent",
  () =>
    runNative(
      Effect.gen(function* () {
        const owner = yield* setup();

        yield* Effect.forEach(
          ["read", "write", "dashboard"] as const,
          (scope, index) => verifyDashboardScope(owner, scope, index),
          { discard: true }
        );
      })
    ),
  30000
);

scenario(
  "replays committed PAT Dashboard writes and refuses new growth under storage pressure",
  () =>
    runNative(
      Effect.gen(function* () {
        const ceiling = 4 * 1024 * 1024;
        const store = yield* makeNativeTransactionJourney(String(ceiling), nativeCapacityPlatform);
        const token = "fin_dbwrites_" + "x".repeat(43);
        yield* seedNativePAT({
          db: store,
          userId: alice.user,
          token,
          scopes: ["dashboard"],
          current: DateTime.nowUnsafe().epochMilliseconds,
        });

        const post = (path: string, key: string, body: Schema.Json): Effect.Effect<Response> =>
          native(() =>
            store.send(
              new Request("https://api.fidyapp.com" + path, {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": key,
                },
                body: JSON.stringify(body),
              })
            )
          );

        const initialize = (): Effect.Effect<Response> =>
          post("/dashboard/initialize", "original-initialize", {});

        const edit = (): Effect.Effect<Response> =>
          post("/dashboard/edits", "original-edit", { op: "set-title", title: "Mi tablero" });

        const namespace = yield* native(() =>
          store.runtime.getDurableObjectNamespace("USER_STORE", "core")
        );

        const readBytes = Effect.fn(function* () {
          const response = yield* native(() =>
            namespace.getByName(alice.user).fetch("https://fixture.invalid/database-size")
          );

          expect(response.status).toBe(200);

          return yield* Schema.decodeUnknownEffect(Schema.Int)(
            yield* native(() => response.json())
          );
        });

        const warning = ceiling * 0.7;
        const restricted = ceiling * 0.8;
        const initialBytes = yield* readBytes();
        expect(initialBytes).toBeLessThan(warning);
        const original = yield* initialize();
        const changed = yield* edit();
        expect([original.status, changed.status]).toEqual([200, 200]);
        yield* native(() => store.exec("CREATE TABLE storage_pressure (padding BLOB)"));
        const healthyBytes = yield* readBytes();
        expect(healthyBytes).toBeLessThan(warning);
        const target = Math.ceil(ceiling * 0.85);
        const chunk = 256 * 1024;
        const padding = target - healthyBytes;

        const paddingChunks = Array.from({ length: Math.ceil(padding / chunk) }, (_, index) =>
          Math.min(chunk, padding - index * chunk)
        );

        yield* Effect.forEach(
          paddingChunks,
          (size) =>
            native(() => store.exec("INSERT INTO storage_pressure VALUES(zeroblob(?))", size)),
          { discard: true }
        );

        const pressureBytes = yield* readBytes();
        expect(pressureBytes).toBeGreaterThanOrEqual(restricted);
        expect(pressureBytes).toBeLessThan(ceiling);

        const measurement = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          initialBytes,
          healthyBytes,
          pressureBytes,
          ceilingBytes: ceiling,
        });

        process.stdout.write(`DASHBOARD_CAPACITY ${measurement}\n`);

        yield* Effect.forEach(
          [
            [initialize, original],
            [edit, changed],
          ] as const,
          expectReplay,
          { discard: true }
        );

        expect(
          (yield* post("/dashboard/edits", "new-edit", { op: "set-title", title: "Otra" })).status
        ).toBe(503);
        expect((yield* post("/dashboard/initialize", "new-initialize", {})).status).toBe(503);
        expect(
          yield* native(() =>
            store.exec(
              "SELECT revision,(SELECT count(*) FROM canonical_request_receipts) AS receipts,(SELECT sum(units) FROM commercial_allowance_consumptions) AS units FROM user_documents"
            )
          )
        ).toEqual([{ revision: 2, receipts: 2, units: 2 }]);
      })
    )
);

scenario.each(["/dashboard/view", "/dashboard/view?"])(
  "publishes one complete day chart at %s across a concurrent Correction and new SourceAttestation",
  (path) =>
    runNative(
      Effect.gen(function* () {
        const store = yield* setup();
        const zone = IanaTimeZone.make("America/Bogota");

        const from = resolveDashboardPeriod({
          now: DateTime.nowUnsafe(),
          period: "last-7-days",
          timeZone: zone,
        }).from;

        const first = DateTime.add(from, { hours: 1 });
        const second = DateTime.add(first, { days: 1 });

        const firstDay = DateTime.formatIsoDate(
          DateTime.setZone(first, DateTime.zoneMakeNamedUnsafe(zone))
        );

        const secondDay = DateTime.formatIsoDate(
          DateTime.setZone(second, DateTime.zoneMakeNamedUnsafe(zone))
        );

        const doc = {
          title: "Semana",
          layout: {
            kind: "leaf",
            widget: {
              id: "12340000-0000-4000-8000-000000000019",
              type: "spending-chart",
              groupBy: "day",
              period: "last-7-days",
            },
          },
        };

        yield* native(() =>
          store.exec(
            "INSERT INTO user_documents VALUES (?,'dashboard',?,1)",
            alice.user,
            JSON.stringify(doc)
          )
        );

        const capture = Effect.fn(function* (occurredAt: DateTime.Utc) {
          const response = yield* native(() =>
            send(store, 0, {
              path: "/transactions",
              method: "POST",
              body: {
                money: { amount: "10", currency: "COP" },
                direction: "outflow",
                occurredAt: DateTime.formatIso(occurredAt),
              },
            })
          );

          expect(response.status).toBe(201);

          return (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
          )(yield* native(() => response.json()))).data.id;
        });

        const chart = Effect.fn(function* () {
          const [widget] = yield* fetchView(store, path);

          if (widget === undefined || !("buckets" in widget.result)) {
            throw new Error("Expected day chart");
          }

          return widget.result.buckets.map((bucket) => [
            bucket.key.kind === "day" ? bucket.key.date : "",
            BigDecimal.format(bucket.moneyGroups[0]?.outflow.amount ?? BigDecimal.make(0n, 0)),
          ]);
        });

        const id = yield* capture(first);

        const next = yield* Effect.all(
          [
            chart(),
            native(() =>
              send(store, 0, {
                path: "/transactions/" + id,
                method: "PUT",
                body: { expectedRevision: 0, changes: { occurredAt: DateTime.formatIso(second) } },
              })
            ),
          ],
          { concurrency: 2 }
        );

        expect(next[1].status).toBe(200);
        expect([[[firstDay, "10"]], [[secondDay, "10"]]]).toContainEqual(next[0]);
        expect(yield* chart()).toEqual([[secondDay, "10"]]);
        const freshA = yield* capture(first);
        const freshB = yield* capture(second);

        const linked = yield* native(() =>
          send(store, 0, {
            path: "/transactions/link",
            method: "POST",
            body: { firstTransactionId: freshA, secondTransactionId: freshB },
          })
        );

        expect(linked.status).toBe(200);

        const visible = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
        )(yield* native(() => linked.json()))).data.id;

        const hidden = visible === freshA ? freshB : freshA;

        const before =
          visible === freshA
            ? [
                [firstDay, "10"],
                [secondDay, "10"],
              ]
            : [[secondDay, "20"]];

        const after =
          visible === freshA
            ? [[secondDay, "20"]]
            : [
                [firstDay, "10"],
                [secondDay, "10"],
              ];

        expect(yield* chart()).toEqual(before);
        yield* native(() =>
          store.exec(
            "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms) VALUES('later-statement',?,?,'statement-line','CO','es-CO','America/Bogota','statement-v1',?)",
            alice.user,
            hidden,
            DateTime.nowUnsafe().epochMilliseconds
          )
        );
        expect(yield* chart()).toEqual(after);
      })
    ),
  30000
);

const initializedDocument = Effect.fn(function* (store: Journey) {
  const response = yield* native(() => initialize(store));
  expect(response.status).toBe(200);

  return yield* native(() => response.json());
});

scenario(
  "serializes concurrent initialization and edits without overwriting an established Dashboard",
  () =>
    runNative(
      Effect.gen(function* () {
        const store = yield* setup();

        const documents = (): Effect.Effect<ReadonlyArray<unknown>> =>
          Effect.forEach([0, 1], () => initializedDocument(store), { concurrency: 2 });

        const first = yield* documents();
        expect(first[0]).toEqual(first[1]);
        expect(first[0]).toMatchObject({ data: { title: "Tablero" } });

        const writes = yield* Effect.forEach(
          ["Primero", "Segundo"],
          (title) =>
            native(() =>
              send(store, 0, {
                path: "/dashboard/edits",
                method: "POST",
                body: { op: "set-title", title },
              })
            ),
          { concurrency: 2 }
        );

        expect(writes.map((response) => response.status)).toEqual([200, 200]);

        const before = yield* native(() =>
          store.exec("SELECT revision,document_json FROM user_documents")
        );

        expect(before).toMatchObject([{ revision: 3 }]);
        const after = yield* documents();
        expect(after[0]).toEqual(after[1]);
        expect(
          yield* native(() => store.exec("SELECT revision,document_json FROM user_documents"))
        ).toEqual(before);
      })
    ),
  30000
);

scenario(
  "reuses the same complete pages across 24 list Widgets and refreshes the next native view",
  () =>
    runNative(
      Effect.gen(function* () {
        const store = yield* setup();

        const document = yield* Schema.decodeUnknownEffect(DashboardDocument)({
          title: "Listas",
          layout: {
            kind: "split",
            axis: "column",
            children: Array.from({ length: 24 }, (_, index) => {
              const widget = {
                id: `33300000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                type: "transaction-list",
                limit: index === 23 ? 2 : 50,
              };

              const categorized =
                index === 21
                  ? { ...widget, categories: ["10000000-0000-4000-8000-000000000002"] }
                  : widget;

              return {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: index === 22 ? { ...categorized, search: "missing" } : categorized,
                },
              };
            }),
          },
        });

        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(DashboardDocument))
        )(document);

        yield* native(() =>
          store.exec("INSERT INTO user_documents VALUES (?,'dashboard',?,1)", alice.user, encoded)
        );
        yield* native(() =>
          store.exec(
            "INSERT INTO categories VALUES (?,'Restaurantes',3)",
            "10000000-0000-4000-8000-000000000001"
          )
        );
        yield* native(() =>
          store.exec(
            `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms)
      WITH RECURSIVE sequence(number) AS (SELECT 0 UNION ALL SELECT number+1 FROM sequence WHERE number<249)
      SELECT printf('77700000-0000-4000-8000-%012d',number),?,'0.01','COP','outflow',?,?,? FROM sequence`,
            alice.user,
            "10000000-0000-4000-8000-000000000001",
            1,
            1
          )
        );

        const check = Effect.fn(function* (expected: string) {
          const widgets = yield* fetchView(store);
          expect(widgets).toHaveLength(24);
          widgets.forEach((widget, index) =>
            assertListSelection({ node: { kind: "leaf", widget }, index, firstId: expected })
          );
        });

        yield* check("77700000-0000-4000-8000-000000000249");

        const response = yield* native(() =>
          send(store, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "1", currency: "COP" },
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          })
        );

        expect(response.status).toBe(201);

        const { data } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
        )(yield* native(() => response.json()));

        yield* check(data.id);
      })
    ),
  30000
);

scenario(
  "withholds an impossible stored total and a failed capture adds no Dashboard contribution",
  () =>
    runNative(
      Effect.gen(function* () {
        const store = yield* initializedSetup();

        const capture = (): Promise<Response> =>
          send(store, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "21.37", currency: "COP" },
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          });

        yield* native(() =>
          store.exec(
            "CREATE TRIGGER skip_bucket BEFORE INSERT ON transaction_projection_bucket BEGIN SELECT RAISE(IGNORE); END"
          )
        );
        expect((yield* native(capture)).status).toBe(503);
        yield* native(() => store.exec("DROP TRIGGER skip_bucket"));
        expect(yield* metricTotals(yield* native(() => send(store, 0, "/dashboard/view")))).toEqual(
          []
        );
        expect((yield* native(capture)).status).toBe(201);
        expect(yield* metricTotals(yield* native(() => send(store, 0, "/dashboard/view")))).toEqual(
          ["21.37"]
        );
        yield* native(() => store.exec("UPDATE transaction_projection_bucket SET count=2"));
        expect((yield* native(() => send(store, 0, "/dashboard/view"))).status).toBe(503);
        yield* native(() => store.exec("UPDATE transaction_projection_bucket SET count=1"));
        yield* native(() => store.exec("UPDATE transaction_projection_digit SET digit_sum=0"));
        expect((yield* native(() => send(store, 0, "/dashboard/view"))).status).toBe(503);
      })
    ),
  30000
);

scenario("removes a deleted Transaction from exact Dashboard and Budget totals", () =>
  runNative(
    Effect.gen(function* () {
      const store = yield* initializedSetup();
      const categoryId = "10000000-0000-4000-8000-000000000016";
      const money = { amount: "9007199254740993.15", currency: "COP" };
      const occurredAt = DateTime.formatIso(yield* DateTime.now);

      const month = DateTime.formatIsoDate(
        DateTime.makeZonedUnsafe(occurredAt, { timeZone: "America/Bogota" })
      ).slice(0, 7);

      const budget = yield* native(() =>
        send(store, 0, {
          path: "/budgets",
          method: "POST",
          body: { categoryId, cap: money, month },
        })
      );

      expect(budget.status).toBe(201);

      const captured = yield* native(() =>
        send(store, 0, {
          path: "/transactions",
          method: "POST",
          body: { categoryId, money, direction: "outflow", occurredAt },
        })
      );

      expect(captured.status).toBe(201);

      const { data } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
      )(yield* native(() => captured.json()));

      const observe = Effect.fn(function* (expected: ReadonlyArray<string>, spent: string) {
        expect(yield* metricTotals(yield* native(() => send(store, 0, "/dashboard/view")))).toEqual(
          expected
        );

        const status = yield* native(() =>
          send(store, 0, "/budget-status?timeZone=America%2FBogota&month=" + month)
        );

        expect(status.status).toBe(200);
        expect(yield* native(() => status.json())).toMatchObject({
          data: { statuses: [{ spent: { amount: spent, currency: "COP" } }] },
        });
      });

      yield* observe([money.amount], money.amount);
      expect(
        (yield* native(() =>
          send(store, 0, { path: "/transactions/" + data.id, method: "DELETE" })
        )).status
      ).toBe(200);
      yield* observe([], "0");
    })
  )
);
