import { BigDecimal, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { type TransactionCaptureTask, makeCaptureRetention } from "./capture-task";
import type { CaptureDraft } from "./capture-draft";

const categoryId = "24000000-0000-4000-8000-000000000242";
const transaction = {
  id: "25000000-0000-4000-8000-000000000001",
  categoryId,
  money: { amount: "64000", currency: "COP" },
  counterparty: "Prueba",
  notes: undefined,
  direction: "outflow",
  occurredAt: "2026-10-23T05:00:00.000Z",
  createdAt: "2026-10-23T12:00:00.000Z",
  revision: 1,
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.useRealTimers();
});
type Fixture = Readonly<{
  attach: (timeZone?: string) => () => void;
  behavior: { delay: number; status: number; body: string };
  dispose: () => void;
  requests: Array<string>;
  view: () => TransactionCaptureTask;
}>;
const fixture = (activate = true): Fixture => {
  vi.useFakeTimers();
  const requests: Array<string> = [];
  const behavior = { delay: 0, status: 201, body: JSON.stringify({ data: transaction, next: [] }) };
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.method);
        return Effect.sleep(behavior.delay).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(behavior.body, {
                status: behavior.status,
                headers: { "content-type": "application/json" },
              })
            )
          )
        );
      })
    ),
  });
  const timeZone = "America/Bogota";
  const initial: CaptureDraft = {
    amount: "64000",
    currency: "COP",
    direction: "outflow",
    counterparty: "Prueba",
    notes: "",
    categoryId,
    occurredOn: "2026-10-23",
  };
  const retention = makeCaptureRetention({
    input: { client, timeZone, initial },
    identity: timeZone,
  });
  const registry = AtomRegistry.make();
  cleanup.push(() => registry.dispose(), registry.mount(retention));
  const attach = (nextTimeZone = timeZone): (() => void) => {
    const detach = registry
      .get(retention)
      .mount({ client, timeZone: nextTimeZone, initial }, nextTimeZone);
    cleanup.push(detach);
    return detach;
  };
  return {
    attach,
    behavior,
    dispose: activate ? attach() : () => {},
    requests,
    view: (): TransactionCaptureTask =>
      registry.get(Option.getOrThrow(registry.get(retention).resource)),
  };
};

it.effect("exposes the initial draft without admitting a create before its attachment", () =>
  Effect.gen(function* () {
    const harness = fixture(false);
    const command = { categories: [], invalidate: (): void => {}, onCreated: (): void => {} };
    expect(harness.view().draft.amount).toBe("64000");
    harness.view().change({ ...harness.view().draft, amount: "65000" });
    harness.view().submit(command);
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    expect(harness.requests).toEqual([]);
    expect(harness.view().draft.amount).toBe("64000");
    harness.attach("America/Lima");
    expect(harness.view().timeZone).toBe("America/Lima");
    harness.view().submit(command);
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    expect(harness.requests).toEqual(["POST"]);
  })
);
it.effect(
  "keeps the committed Transaction and create lock when its presentation callback throws",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      let notified = 0;
      let safeBeforePresentation = false;
      let safeBeforeInvalidation = false;
      harness.view().submit({
        categories: [],
        invalidate: () => {
          safeBeforeInvalidation = Option.isSome(harness.view().created);
        },
        onCreated: (created) => {
          notified += 1;
          safeBeforePresentation = Option.exists(
            harness.view().created,
            (saved) => saved.id === created.id
          );
          throw new Error("Presentation defect");
        },
      });
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(Option.getOrThrow(harness.view().created).id).toBe(transaction.id);
      expect(harness.view().uncertain).toBe(false);
      harness.view().submit({
        categories: [],
        invalidate: () => {},
        onCreated: () => {
          notified += 1;
        },
      });
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(notified).toBe(1);
      expect(safeBeforePresentation).toBe(true);
      expect(safeBeforeInvalidation).toBe(true);
      expect(harness.requests).toEqual(["POST"]);
    })
);

it.effect(
  "fences a late committed result immediately on disposal and retains uncertain admission on remount",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      harness.behavior.delay = 100;
      let notified = 0;
      harness.view().submit({
        categories: [],
        invalidate: () => {},
        onCreated: () => {
          notified += 1;
        },
      });
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.requests).toEqual(["POST"]);
      harness.dispose();
      harness.attach("America/Lima");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(100));
      expect(notified).toBe(0);
      expect(harness.view().uncertain).toBe(true);
      expect(harness.view().saving).toBe(false);
      expect(harness.view().timeZone).toBe("America/Bogota");
      expect(Option.getOrThrow(harness.view().attempt).amount).toBe("64000");
      expect(harness.view().draft.amount).toBe("64000");
      harness.view().submit({
        categories: [],
        invalidate: () => {},
        onCreated: () => {
          notified += 1;
        },
      });
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.requests).toEqual(["POST"]);
    })
);
it.effect(
  "rejects invalid Money and local days before reserving a create, then admits one synchronous submission",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      const initial = harness.view().draft;
      const command = { categories: [], invalidate: (): void => {}, onCreated: (): void => {} };
      harness.view().change({ ...initial, amount: "0" });
      harness.view().submit(command);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.requests).toEqual([]);
      harness.view().change({ ...initial, occurredOn: "2026-02-30" });
      harness.view().submit(command);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.requests).toEqual([]);
      harness.view().change(initial);
      harness.view().submit(command);
      harness.view().submit(command);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.requests).toEqual(["POST"]);
      expect(BigDecimal.format(Option.getOrThrow(harness.view().created).money.amount)).toBe(
        "64000"
      );
    })
);
it.effect("retains the correctable draft after a canonical nonadmission refusal", () =>
  Effect.gen(function* () {
    const harness = fixture();
    harness.behavior.status = 400;
    harness.behavior.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      _tag: "ValidationFailed",
      error: { code: "validation_failed", message: "Refused", fields: [] },
      next: [],
    });
    const command = { categories: [], invalidate: (): void => {}, onCreated: (): void => {} };
    harness.view().submit(command);
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    expect(harness.view().rejected).toBe(true);
    expect(harness.view().draft.amount).toBe("64000");
    harness.behavior.status = 201;
    harness.behavior.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      data: transaction,
      next: [],
    });
    harness.view().change({ ...harness.view().draft, amount: "65000" });
    harness.view().submit(command);
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    expect(harness.requests).toEqual(["POST", "POST"]);
    expect(Option.isSome(harness.view().created)).toBe(true);
  })
);
it.effect(
  "keeps malformed acknowledged outcomes locked with the original draft and no automatic replay",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      harness.behavior.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        data: { id: transaction.id },
        next: [],
      });
      const command = { categories: [], invalidate: (): void => {}, onCreated: (): void => {} };
      harness.view().submit(command);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.view().uncertain).toBe(true);
      expect(Option.getOrThrow(harness.view().attempt).amount).toBe("64000");
      harness.view().change({ ...harness.view().draft, amount: "65000" });
      harness.view().submit(command);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(harness.view().draft.amount).toBe("64000");
      expect(harness.requests).toEqual(["POST"]);
    })
);
