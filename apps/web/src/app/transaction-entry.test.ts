// @vitest-environment jsdom
import { it } from "@effect/vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import { type Cause, Deferred, Effect, Layer, Option, Schema } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { BrowserSessionBindingSchema, makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { makeHostedTurnClient } from "@/transport/hosted-turn-client";
import { PrivacyTransactionFeature, TransactionListFeature } from "@/features/transactions/feature";
import { transactionEntryConsent } from "@/session/transaction-entry";
import { initialApplicationValues } from "./initial-values";
import { createWebRouter } from "./routes";

const observedAt = Date.parse("2026-11-08T12:00:00Z");
const profile = {
  data: {
    id: "10000000-0000-4000-8000-000000000001",
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    createdAt: "2026-01-01T00:00:00.000Z",
    trialPeriod: { startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-08T00:00:00.000Z" },
  },
  next: [],
  categories: [],
};
const initial = Schema.decodeUnknownSync(BrowserSessionBindingSchema)({
  binding: "20000000-0000-4000-8000-000000000001",
  initial: { status: "Granted", withdrawal: null, profile },
});
const revoked = {
  status: "Revoked",
  withdrawal: { reference: "30000000-0000-4000-8000-000000000001", occurredAtMs: observedAt },
};
beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => import("./transactions-page"));
      yield* Effect.tryPromise(() => TransactionListFeature.preload());
      yield* Effect.tryPromise(() => PrivacyTransactionFeature.preload());
    })
  )
);
afterEach(() => vi.useRealTimers());

type EntryControl = {
  consent: "Granted" | "Revoked" | "Unavailable";
  transactions: Option.Option<Deferred.Deferred<void>>;
};
type EntryFixture = Readonly<{
  router: ReturnType<typeof createWebRouter>;
  registry: AtomRegistry.AtomRegistry;
  webAuthClient: ReturnType<typeof makeWebAuthClient>;
  requests: Array<Readonly<{ method: string; path: string; search: string }>>;
  control: EntryControl;
  finishPreparation: () => Effect.Effect<void, Cause.UnknownError>;
}>;
const entryFixture = (age: Option.Option<number>): EntryFixture => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(observedAt + Option.getOrElse(age, () => 0));
  const requests: Array<Readonly<{ method: string; path: string; search: string }>> = [];
  const control: EntryControl = {
    consent: "Granted",
    transactions: Option.none(),
  };
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      search: UrlParams.toString(request.urlParams),
    });
    const consent = url.pathname === "/web/consent";
    return Effect.gen(function* () {
      if (url.pathname === "/transactions" && Option.isSome(control.transactions)) {
        yield* Deferred.await(control.transactions.value);
      }
      if (consent) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            control.consent === "Revoked" ? revoked : { status: "Granted", withdrawal: null },
            { status: control.consent === "Unavailable" ? 503 : 200 }
          )
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(url.pathname === "/transactions" ? { data: [], next: [] } : profile)
      );
    });
  });
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  };
  const apiClient = makeFidyClient(options);
  const webAuthClient = makeWebAuthClient(options);
  const registry = AtomRegistry.make({
    initialValues: Option.isNone(age)
      ? []
      : initialApplicationValues({
          apiClient,
          webAuthClient,
          initial: {
            binding: initial.binding ?? "none",
            initial: initial.initial,
            receivedAt: observedAt,
          },
        }),
  });
  const router = createWebRouter({
    apiClient,
    webAuthClient,
    hostedTurnClient: makeHostedTurnClient(options),
    sessionBinding: initial.binding ?? "none",
    registry,
    history: Option.some(createMemoryHistory({ initialEntries: ["/app/transactions"] })),
  });
  const finishPreparation = (): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        Promise.resolve(router.state.matches.at(-1)?.loaderData?.preparation)
      );
      expect(router.state.matches.at(-1)?.status).toBe("success");
    });
  return { router, registry, webAuthClient, requests, control, finishPreparation };
};

it.live.each([0, 399])(
  "the initial Transactions entry uses its %i ms bootstrap once and keeps its observation time",
  (age) =>
    Effect.gen(function* () {
      const fixture = entryFixture(Option.some(age));
      const { router, registry, webAuthClient, control, requests, finishPreparation } = fixture;
      try {
        yield* Effect.tryPromise(() => router.load());
        yield* finishPreparation();
        const consent = registry.get(transactionEntryConsent(webAuthClient));
        expect(AsyncResult.isSuccess(consent) && consent.timestamp).toBe(observedAt);
        expect(requests.filter((request) => request.path === "/web/consent")).toEqual([]);
        yield* Effect.tryPromise(() => router.navigate({ to: "/settings/privacy" }));
        control.consent = "Revoked";
        requests.length = 0;
        yield* Effect.tryPromise(() => router.navigate({ to: "/app/transactions" }));
        yield* finishPreparation();
        expect(requests.map((request) => request.path)).toEqual(["/web/consent"]);
      } finally {
        registry.dispose();
      }
    })
);

it.live.each([400, -1])(
  "a %i ms bootstrap cannot admit ordinary queries before a fresh Consent check",
  (age) =>
    Effect.gen(function* () {
      const { router, registry, control, requests, finishPreparation } = entryFixture(
        Option.some(age)
      );
      control.consent = "Revoked";
      try {
        yield* Effect.tryPromise(() => router.load());
        yield* finishPreparation();
        expect(requests.map((request) => request.path)).toEqual(["/web/consent"]);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "month navigation keeps the entry Consent and prepares the new Colombian calendar period",
  () =>
    Effect.gen(function* () {
      const { router, registry, requests, finishPreparation } = entryFixture(Option.some(0));
      try {
        yield* Effect.tryPromise(() => router.load());
        yield* finishPreparation();
        requests.length = 0;
        yield* Effect.tryPromise(() =>
          router.navigate({ to: "/app/transactions", search: { month: "2026-10" } })
        );
        yield* finishPreparation();
        expect(requests.map((request) => request.path)).toEqual(["/transactions"]);
        expect(requests[0]?.search).toContain("2026-10-01T05%3A00%3A00.000Z");
        expect(requests[0]?.search).toContain("2026-11-01T05%3A00%3A00.000Z");
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "a failed re-entry refresh retains Granted only as stale data and admits no ordinary query",
  () =>
    Effect.gen(function* () {
      const { router, registry, webAuthClient, control, requests, finishPreparation } =
        entryFixture(Option.none());
      try {
        yield* Effect.tryPromise(() => router.load());
        yield* finishPreparation();
        yield* Effect.tryPromise(() => router.navigate({ to: "/settings/privacy" }));
        control.consent = "Unavailable";
        requests.length = 0;
        yield* Effect.tryPromise(() => router.navigate({ to: "/app/transactions" }));
        yield* finishPreparation();
        const consent = registry.get(transactionEntryConsent(webAuthClient));
        expect(AsyncResult.isFailure(consent)).toBe(true);
        expect(Option.getOrThrow(AsyncResult.value(consent)).status).toBe("Granted");
        expect(requests.map((request) => request.path)).toEqual(["/web/consent"]);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "a cancelled entry cannot spend the initial handoff or donate ordinary preparation to the next entry",
  () =>
    Effect.gen(function* () {
      const { router, registry, requests, finishPreparation } = entryFixture(Option.some(0));
      const { TransactionsPage } = yield* Effect.tryPromise(() => import("./transactions-page"));
      const cancelled = new AbortController();
      cancelled.abort();
      try {
        const retired = yield* Effect.tryPromise(() =>
          TransactionsPage.prepareEntry({
            context: router.options.context,
            search: {},
            cause: "enter",
            preload: false,
            signal: cancelled.signal,
          })
        );
        yield* Effect.tryPromise(() => Promise.resolve(retired?.preparation));
        expect(retired).toBeUndefined();
        expect(requests).toEqual([]);
        yield* Effect.tryPromise(() => router.load());
        yield* finishPreparation();
        expect(requests.filter((request) => request.path === "/web/consent")).toEqual([]);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "entry authority resolves before ordinary data and departure retires the returned preparation",
  () =>
    Effect.gen(function* () {
      const { router, registry, control, requests } = entryFixture(Option.some(0));
      const release = Deferred.makeUnsafe<void>();
      control.transactions = Option.some(release);
      try {
        yield* Effect.tryPromise(() => router.load());
        expect(router.state.matches.at(-1)?.status).toBe("success");
        const preparation = router.state.matches.at(-1)?.loaderData?.preparation;
        expect(preparation).toBeDefined();
        const expectOrdinaryRequest = (): void => {
          expect(requests.map((request) => request.path)).toEqual(["/transactions"]);
        };
        yield* Effect.tryPromise(() => vi.waitFor(expectOrdinaryRequest));
        yield* Effect.tryPromise(() => router.navigate({ to: "/settings/privacy" }));
        yield* Effect.tryPromise(() => Promise.resolve(preparation));
        expect(router.state.location.pathname).toBe("/settings/privacy");
        expect(requests.every((request) => request.method === "GET")).toBe(true);
      } finally {
        yield* Deferred.succeed(release, undefined);
        registry.dispose();
      }
    })
);
