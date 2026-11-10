import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { makeFreshQuery } from "@/transport/fresh-query";
import { makeFidyClient } from "@/transport/client";
import { type TransactionCorrections, makeTransactionCorrections } from "./corrections";
import { type HistoryState, transactionHistory } from "./history";

const firstId = "25000000-0000-4000-8000-000000000001";
const secondId = "25000000-0000-4000-8000-000000000002";
const categoryId = "24000000-0000-4000-8000-000000000242";
const initialRecord = {
  id: firstId,
  categoryId,
  money: { amount: "64000", currency: "COP" },
  counterparty: "Prueba",
  notes: "Nota anterior",
  direction: "outflow",
  occurredAt: "2026-10-23T12:00:00.000Z",
  createdAt: "2026-10-23T12:00:00.000Z",
  revision: 1,
};
const record = (id: string): typeof initialRecord => ({ ...initialRecord, id });
const resources: Array<() => void> = [];
afterEach(() => {
  resources
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.useRealTimers();
});
const advance = Effect.fnUntraced(function* (milliseconds: number = 0) {
  yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(milliseconds));
});
const readFixturePage = (
  records: ReadonlyArray<typeof initialRecord>,
  paginated: boolean,
  later: boolean
): unknown => ({
  data: paginated ? records.slice(later ? 1 : 0, later ? 2 : 1) : records,
  next:
    paginated && !later
      ? [
          {
            tool: "transactions.listTransactions",
            hint: "Continue browsing the next page of your FinancialRecord.",
            args: {
              query: {
                from: "2026-10-01T00:00:00.000Z",
                to: "2026-11-01T00:00:00.000Z",
                cursor: `${initialRecord.occurredAt}|${initialRecord.createdAt}|${firstId}`,
              },
            },
          },
        ]
      : [],
});
const fixtureDetail = Effect.fnUntraced(function* (
  path: string,
  detail: Readonly<{ outcome: string; delay: number }>,
  lookups: Array<string>
) {
  lookups.push(path);
  yield* Effect.sleep(detail.delay);
  if (detail.outcome === "missing") {
    return {
      status: 404,
      data: { error: { code: "not_found", message: "Transaction not found" }, next: [] },
    };
  }
  return {
    status: detail.outcome === "failure" ? 503 : 200,
    data: {
      data: {
        ...record(path.split("/").at(-1) ?? firstId),
        reconciliation: { kind: "independent" },
        sources: [],
        presentation: { kind: "independent" },
      },
      next: [],
    },
  };
});
const savedFixtureData = (path: string, records: ReadonlyArray<typeof initialRecord>): unknown =>
  path.endsWith("/corrections") ? { updated: records.length } : records[0];
const fixture = Effect.fnUntraced(function* (paginated: boolean = false) {
  vi.useFakeTimers();
  const records = [record(firstId), record(secondId)];
  const sent: Array<{ path: string; body: string }> = [];
  const behavior = { failRead: false, write: "success", delay: 0, readDelay: 0 };
  const lookups: Array<string> = [];
  const detail = { outcome: "success", delay: 0 };
  let saved = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      let data: unknown;
      let status = 200;
      if (request.method !== "GET") {
        sent.push({
          path,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        yield* Effect.sleep(behavior.delay);
        if (behavior.write === "uncertain") status = 503;
        if (behavior.write === "rejected") {
          status = 400;
          data = {
            _tag: "ValidationFailed",
            error: { code: "validation_failed", message: "Invalid", fields: [] },
            next: [],
          };
        } else {
          data = {
            data: savedFixtureData(path, records),
            next: [],
          };
        }
      } else {
        yield* Effect.sleep(behavior.readDelay);
        if (behavior.failRead) status = 503;
        if (path.startsWith("/transactions/")) {
          const response = yield* fixtureDetail(path, detail, lookups);
          data = response.data;
          status = response.status;
        } else {
          data = path.endsWith("categories")
            ? { data: [{ id: categoryId, label: "Restaurantes" }], next: [] }
            : readFixturePage(
                records,
                paginated,
                request.urlParams.params.some(([key]) => key === "cursor")
              );
        }
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(data), {
          status,
          headers: { "content-type": "application/json" },
        })
      );
    }).pipe(Effect.orDie)
  );
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  });
  const registry = AtomRegistry.make();
  resources.push(() => registry.dispose());
  const period = {
    from: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    to: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
  };
  const firstPage = makeFreshQuery({
    runtime: client.runtime,
    load: Effect.gen(function* () {
      const api = yield* client;
      return yield* api.transactions.listTransactions({ query: period });
    }),
    decorate: revalidateWorkspaceQuery,
  });
  const categories = makeFreshQuery({
    runtime: client.runtime,
    load: Effect.gen(function* () {
      const api = yield* client;
      return yield* api.categories.listCategories();
    }),
    decorate: revalidateWorkspaceQuery,
  });
  const history = transactionHistory({
    initialPages: 1,
    apiClient: client,
    firstPage,
    period,
    locate: Option.none(),
  });
  const atom = makeTransactionCorrections({
    client,
    firstPage,
    categories,
    history: history.state,
    historyAction: history.action,
    saved: () => {
      saved += 1;
    },
  });
  resources.push(
    registry.mount(firstPage),
    registry.mount(categories),
    registry.mount(history.state),
    registry.mount(atom)
  );
  const dispose = registry.get(atom).mount();
  resources.push(dispose);
  yield* advance();
  const transactions = (yield* AtomRegistry.getResult(registry, firstPage)).data;
  const transaction = transactions[0];
  if (transaction === undefined) throw new Error("Missing fixture Transaction");
  return {
    view: (): TransactionCorrections => registry.get(atom),
    transaction,
    transactions,
    sent,
    lookups,
    detail,
    behavior,
    dispose,
    records,
    history: (): HistoryState => registry.get(history.state),
    more: (): void => registry.set(history.action, "more"),
    saved: (): number => saved,
  };
});

it.effect("admits one revision-bound Correction synchronously and rereads after success", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.delay = 50;
    const correction = {
      kind: "single" as const,
      origin: "inline" as const,
      transaction: test.transaction,
      changes: { counterparty: "Updated" },
    };
    test.view().submit(correction);
    test.view().submit(correction);
    expect(test.view().status).toBe("saving");
    expect(Option.contains(test.view().inlineTransaction, test.transaction.id)).toBe(true);
    yield* advance(50);
    expect(test.sent).toHaveLength(1);
    expect(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(test.sent[0]?.body ?? "")
    ).toEqual({ expectedRevision: 1, changes: { counterparty: "Updated" } });
    expect(test.view().locked).toBe(false);
    expect(test.saved()).toBe(1);
  })
);

it.effect("automatically rereads after a rejected Correction without replaying the write", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.write = "rejected";
    test.behavior.readDelay = 50;
    test.view().submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { notes: "Nota sin guardar" },
    });
    yield* advance();
    expect(test.view().locked).toBe(true);
    expect(test.view().status).toBe("refreshing");
    yield* advance(50);
    expect(test.view().locked).toBe(false);
    expect(test.view().status).toBe("recovered");
    expect(test.sent).toHaveLength(1);
    expect(test.saved()).toBe(0);
    yield* advance(100);
    expect(test.sent).toHaveLength(1);
  })
);

it.effect("rejected recovery retains later history pages until their fresh reads complete", () =>
  Effect.gen(function* () {
    const test = yield* fixture(true);
    test.more();
    yield* advance();
    const history = test.history().query;
    if (history._tag !== "Ready") throw new Error("Missing history");
    const later = history.value.data[1];
    if (later === undefined) throw new Error("Missing later Transaction");
    test.behavior.write = "rejected";
    test.behavior.readDelay = 50;
    test.view().submit({
      kind: "single",
      origin: "editor",
      transaction: later,
      changes: { notes: "Retained" },
    });
    yield* advance();
    const pending = test.history().query;
    expect(
      pending._tag === "Ready" && pending.value.data.some((item) => item.id === secondId)
    ).toBe(true);
    yield* advance(50);
    expect(test.view().locked).toBe(true);
    yield* advance(50);
    expect(test.view().locked).toBe(false);
    const refreshed = test.history().query;
    expect(
      refreshed._tag === "Ready" && refreshed.value.data.some((item) => item.id === secondId)
    ).toBe(true);
    expect(test.sent).toHaveLength(1);
  })
);

it.effect("keeps all editing paths locked after a lost acknowledgement and failed reread", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.write = "uncertain";
    test.view().submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { counterparty: "Updated" },
    });
    yield* advance();
    expect(test.view().status).toBe("uncertain");
    expect(Option.isNone(test.view().inlineTransaction)).toBe(true);
    test.view().submit({
      kind: "bulk",
      transactions: test.transactions,
      changes: { counterparty: "Another" },
    });
    test.behavior.failRead = true;
    test.behavior.readDelay = 50;
    test.view().recover();
    yield* advance();
    expect(test.view().status).toBe("recovering");
    expect(test.view().locked).toBe(true);
    yield* advance(50);
    expect(test.view().status).toBe("uncertain");
    expect(test.view().locked).toBe(true);
    expect(test.sent).toHaveLength(1);
    test.view().recover();
    yield* advance();
    expect(test.view().status).toBe("recovering");
    yield* advance(50);
    expect(test.view().status).toBe("uncertain");
    test.behavior.failRead = false;
    test.view().recover();
    yield* advance();
    expect(test.view().status).toBe("recovering");
    yield* advance(50);
    expect(test.view().locked).toBe(false);
    expect(test.sent).toHaveLength(1);
  })
);

it.effect(
  "keeps bulk Correction atomic and rejects duplicate or stale observed revisions before sending",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      test.view().submit({
        kind: "bulk",
        transactions: [test.transaction, test.transaction],
        changes: { counterparty: "Duplicate" },
      });
      expect(test.view().status).toBe("refreshing");
      expect(test.sent).toHaveLength(0);
      test.view().recover();
      yield* advance();
      test.view().submit({
        kind: "single",
        origin: "editor",
        transaction: { ...test.transaction, revision: 0 },
        changes: { counterparty: "Stale" },
      });
      expect(test.view().status).toBe("refreshing");
      expect(test.sent).toHaveLength(0);
      test.view().recover();
      yield* advance();
      test.behavior.write = "uncertain";
      test.view().submit({
        kind: "bulk",
        transactions: test.transactions,
        changes: { counterparty: "Together" },
      });
      yield* advance();
      expect(test.sent).toHaveLength(1);
      expect(test.sent[0]?.path).toBe("/transactions/corrections");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(test.sent[0]?.body ?? "")
      ).toMatchObject({
        transactions: [
          { id: firstId, expectedRevision: 1 },
          { id: secondId, expectedRevision: 1 },
        ],
        changes: { counterparty: "Together" },
      });
      expect(test.view().status).toBe("uncertain");
    })
);

it.effect("disposal stops pending completion and an obsolete view cannot submit more work", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.delay = 50;
    const view = test.view();
    view.submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { counterparty: "Sent" },
    });
    yield* advance();
    test.dispose();
    view.submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { counterparty: "Stale view" },
    });
    yield* advance(50);
    expect(test.sent).toHaveLength(1);
    expect(test.saved()).toBe(0);
  })
);

it.live("reading and disposing history does not initialize the correction transport", () =>
  Effect.gen(function* () {
    let initialized = 0;
    const transport = Layer.effect(
      HttpClient.HttpClient,
      Effect.sync(() => {
        initialized += 1;
        return HttpClient.make(() => Effect.die(new Error("No request during read-only mounting")));
      })
    );
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: transport,
    });
    const period = {
      from: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      to: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
    };
    const firstPage = client.query("transactions", "listTransactions", {
      query: period,
      ...workspaceQueryRetention,
    });
    const categories = client.query("categories", "listCategories", workspaceQueryRetention);
    const history = transactionHistory({
      initialPages: 1,
      apiClient: client,
      firstPage,
      period,
      locate: Option.none(),
    });
    const corrections = makeTransactionCorrections({
      client,
      firstPage,
      categories,
      history: history.state,
      historyAction: history.action,
      saved: () => undefined,
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(corrections);
    try {
      const dispose = registry.get(corrections).mount();
      yield* Effect.sleep("10 millis");
      expect(initialized).toBe(0);
      dispose();
      yield* Effect.sleep("10 millis");
      expect(initialized).toBe(0);
    } finally {
      unmount();
      registry.dispose();
    }
  })
);

it.effect("deletion review shares Correction admission and consumes confirmation once", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.write = "uncertain";
    expect(test.view().reviewDeletion(test.transaction.id)).toBe(true);
    test.view().submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { notes: "Blocked by deletion review" },
    });
    expect(test.sent).toHaveLength(0);
    test.view().confirmDeletion(test.transaction.id, () => {
      throw new Error("No receipt");
    });
    test.view().confirmDeletion(test.transaction.id, () => {
      throw new Error("Duplicate");
    });
    yield* advance();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.path).toBe(`/transactions/${firstId}`);
    expect(test.sent[0]?.body).toBe("");
    test.view().cancelDeletion(); // Panel disposal cancels only unsent intent.
    expect(test.view().locked).toBe(true);
    expect(test.view().reviewDeletion(test.transaction.id)).toBe(false);
    test.view().submit({
      kind: "bulk",
      transactions: test.transactions,
      changes: { notes: "Still blocked after closing the panel" },
    });
    yield* advance();
    expect(test.sent).toHaveLength(1);
  })
);

it.effect("cancelling unsent deletion retains facts and admits a new Correction", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.view().reviewDeletion(test.transaction.id);
    test.view().cancelDeletion();
    test.view().confirmDeletion(test.transaction.id, () => {
      throw new Error("Cancelled review");
    });
    expect(test.sent).toHaveLength(0);
    test.view().submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { notes: "New action" },
    });
    yield* advance();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.body).toContain("New action");
  })
);

it.effect("recovery waits for a moved identity and refuses stale captured actions", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const captured = test.view();
    captured.submit({
      kind: "bulk",
      transactions: test.transactions,
      changes: { notes: "Unconfirmed atomic changes" },
    });
    // The initial request is acknowledged; its list reread no longer contains one member.
    test.records.splice(1, 1);
    test.detail.delay = 50;
    yield* advance();
    expect(test.view().locked).toBe(true);
    expect(test.lookups).toEqual([`/transactions/${secondId}`]);
    yield* advance(50);
    expect(test.view().locked).toBe(false);
    captured.submit({
      kind: "single",
      origin: "editor",
      transaction: test.transaction,
      changes: { notes: "Obsolete review" },
    });
    yield* advance();
    expect(test.sent).toHaveLength(1);
  })
);

for (const outcome of ["missing", "failure"] as const) {
  it.effect(`unknown deletion recovery requires decoded identity evidence: ${outcome}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      let receipts = 0;
      test.behavior.write = "uncertain";
      test.view().reviewDeletion(test.transaction.id);
      test.view().confirmDeletion(test.transaction.id, () => {
        receipts += 1;
      });
      yield* advance();
      test.view().cancelDeletion(); // Closing the panel cannot discard submitted uncertainty
      test.records.splice(0, 1);
      test.detail.outcome = outcome;
      test.detail.delay = 50;
      test.view().recover();
      yield* advance();
      expect(test.view().locked).toBe(true);
      expect(test.lookups).toEqual([`/transactions/${firstId}`]);
      yield* advance(50);
      expect(test.view().locked).toBe(outcome === "failure");
      expect(receipts).toBe(0);
      expect(test.sent).toHaveLength(1);
    })
  );
}
