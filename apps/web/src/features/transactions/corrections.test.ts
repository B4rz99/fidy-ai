import { DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { type TransactionCorrections, makeTransactionCorrections } from "./corrections";
import { transactionHistory } from "./history";

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
const advance = Effect.fnUntraced(function* (milliseconds = 0) {
  yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(milliseconds));
});
const fixture = Effect.fnUntraced(function* () {
  vi.useFakeTimers();
  const records = [record(firstId), record(secondId)];
  const sent: Array<{ path: string; body: string }> = [];
  const behavior = { failRead: false, write: "success", delay: 0 };
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
        } else data = { data: records[0], next: [] };
      } else {
        if (behavior.failRead) status = 503;
        data = {
          data: path.endsWith("categories") ? [{ id: categoryId, label: "Restaurantes" }] : records,
          next: [],
        };
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
  const firstPage = client.query("transactions", "listTransactions", { query: period });
  const categories = client.query("categories", "listCategories", {});
  const history = transactionHistory({ apiClient: client, firstPage, period });
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
    behavior,
    dispose,
    records,
    saved: (): number => saved,
  };
});

it.effect("admits one revision-bound Correction synchronously and rereads after success", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.delay = 50;
    const correction = {
      kind: "single" as const,
      transaction: test.transaction,
      changes: { counterparty: "Updated" },
    };
    test.view().submit(correction);
    test.view().submit(correction);
    expect(test.view().status).toBe("saving");
    yield* advance(50);
    expect(test.sent).toHaveLength(1);
    expect(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(test.sent[0]?.body ?? "")
    ).toEqual({ expectedRevision: 1, changes: { counterparty: "Updated" } });
    expect(test.view().locked).toBe(false);
    expect(test.saved()).toBe(1);
  })
);

it.effect("keeps all editing paths locked after a lost acknowledgement and failed reread", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.behavior.write = "uncertain";
    test.view().submit({
      kind: "single",
      transaction: test.transaction,
      changes: { counterparty: "Updated" },
    });
    yield* advance();
    expect(test.view().status).toBe("uncertain");
    test.view().submit({
      kind: "bulk",
      transactions: test.transactions,
      changes: { counterparty: "Another" },
    });
    test.behavior.failRead = true;
    test.view().recover();
    yield* advance();
    expect(test.view().status).toBe("uncertain");
    expect(test.view().locked).toBe(true);
    expect(test.sent).toHaveLength(1);
    test.behavior.failRead = false;
    test.view().recover();
    yield* advance();
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
      expect(test.view().status).toBe("rejected");
      expect(test.sent).toHaveLength(0);
      test.view().recover();
      yield* advance();
      test.view().submit({
        kind: "single",
        transaction: { ...test.transaction, revision: 0 },
        changes: { counterparty: "Stale" },
      });
      expect(test.view().status).toBe("rejected");
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
      expect(test.sent[0]?.path).toBe("/operations/atomic-batch");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(test.sent[0]?.body ?? "")
      ).toMatchObject({
        calls: [
          {
            operation: "transactions.updateTransaction",
            input: { params: { id: firstId }, payload: { expectedRevision: 1 } },
          },
          {
            operation: "transactions.updateTransaction",
            input: { params: { id: secondId }, payload: { expectedRevision: 1 } },
          },
        ],
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
      transaction: test.transaction,
      changes: { counterparty: "Sent" },
    });
    yield* advance();
    test.dispose();
    view.submit({
      kind: "single",
      transaction: test.transaction,
      changes: { counterparty: "Stale view" },
    });
    yield* advance(50);
    expect(test.sent).toHaveLength(1);
    expect(test.saved()).toBe(0);
  })
);
