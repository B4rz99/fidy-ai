import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";
import { BrowserSessionBindingSchema, makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { workspaceProfileQuery } from "@/transport/workspace-query";
import { prepareQuery } from "@/transport/query-preparation";
import { initialApplicationValues } from "./initial-values";
import { consumeInitialTransactionConsent, transactionEntryConsent } from "./transaction-entry";

afterEach(() => vi.unstubAllGlobals());
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
const entry = Schema.decodeUnknownSync(BrowserSessionBindingSchema)({
  binding: "20000000-0000-4000-8000-000000000001",
  initial: { status: "Granted", withdrawal: null, profile },
});

it.live(
  "initial metadata hydrates the existing owner without HTTP; refreshing still reads canonical metadata",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          Uint8Array,
          location: { pathname: "/app/transactions" },
        })
      );
      let reads = 0;
      const http = HttpClient.make((request) => {
        reads += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ...profile, data: { ...profile.data, timeZone: "America/New_York" } })
          )
        );
      });
      const transport = Layer.succeed(HttpClient.HttpClient, http);
      const apiClient = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const webAuthClient = makeWebAuthClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const registry = AtomRegistry.make({
        initialValues: initialApplicationValues({
          apiClient,
          webAuthClient,
          initial: {
            binding: entry.binding ?? "none",
            initial: entry.initial,
            receivedAt: Date.now(),
          },
        }),
      });
      yield* Effect.sleep("5 millis");
      try {
        const query = workspaceProfileQuery(apiClient);
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).data.timeZone
        ).toBe("America/Bogota");
        expect(reads).toBe(0);
        registry.refresh(query);
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).data.timeZone
        ).toBe("America/New_York");
        expect(reads).toBe(1);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "only the initial entry consumes its fresh bootstrap Consent; the next entry reads fresh status",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          Uint8Array,
          location: { pathname: "/app/transactions" },
        })
      );
      let reads = 0;
      const http = HttpClient.make((request) => {
        reads += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: "Revoked",
              withdrawal: {
                reference: "30000000-0000-4000-8000-000000000001",
                occurredAtMs: Date.now(),
              },
            })
          )
        );
      });
      const transport = Layer.succeed(HttpClient.HttpClient, http);
      const apiClient = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const webAuthClient = makeWebAuthClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const registry = AtomRegistry.make({
        initialValues: initialApplicationValues({
          apiClient,
          webAuthClient,
          initial: {
            binding: entry.binding ?? "none",
            initial: entry.initial,
            receivedAt: Date.now(),
          },
        }),
      });
      yield* Effect.sleep("5 millis");
      try {
        const query = transactionEntryConsent(webAuthClient);
        expect(consumeInitialTransactionConsent(registry)).toBe(true);
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).status
        ).toBe("Granted");
        expect(reads).toBe(0);
        expect(consumeInitialTransactionConsent(registry)).toBe(false);
        yield* Effect.tryPromise(() =>
          prepareQuery(registry, query, { mode: "fresh", signal: Option.none() })
        );
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).status
        ).toBe("Revoked");
        expect(reads).toBe(1);
      } finally {
        registry.dispose();
      }
    })
);
