import { fireEvent, screen, within } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeFidyClient } from "@/transport/client";
import { mountRecurringDigest } from "./program";

afterEach(cleanupFoldkit);
const identityLength = 12;
const itemCount = 33;
const report = {
  insightEventId: "29000000-0000-4000-8000-000000000099",
  serviceMarket: "CO",
  locale: "es-CO",
  scheduledAt: "2026-10-07T14:00:00Z",
  expiresAt: "2026-10-08T14:00:00Z",
  payload: {
    confirmationDay: {
      localDate: "2026-10-06",
      timeZone: "America/Bogota",
      from: "2026-10-06T05:00:00Z",
      toExclusive: "2026-10-07T05:00:00Z",
    },
    items: Array.from({ length: itemCount }, (_, index) => ({
      confirmationId: `29000000-0000-4000-8000-${String(index).padStart(identityLength, "0")}`,
      seriesId: `29000000-0000-4000-8001-${String(index).padStart(identityLength, "0")}`,
      counterparty: `${String(index).padStart(2, "0")} <script>histórico</script>`,
      money: { amount: "9007199254740993.01", currency: "COP" },
      cadence: { kind: "monthly" },
      confirmedAt: "2026-10-06T19:00:00Z",
    })),
  },
};
const mount = (respond: () => Response): ReturnType<typeof renderFoldkit> => {
  const apiClient = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond())))
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container): (() => void) => {
    const dispose = mountRecurringDigest({
      container,
      apiClient,
      resources: registry.get(apiClient.runtime.layer),
      id: report.insightEventId,
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
it("renders the complete canonical report, exact Money and untrusted labels as text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { container } = mount(() => Response.json({ data: report, next: [] }));
      const list = yield* Effect.tryPromise(() => screen.findByRole("list"));
      expect(within(list).getAllByRole("listitem")).toHaveLength(itemCount);
      expect(screen.getByText("32 <script>histórico</script> · mensual")).toBeVisible();
      expect(container.querySelector("script")).toBeNull();
      expect(screen.getAllByText(/\$.*9.*007.*199.*254.*740.*993/)).toHaveLength(itemCount);
      expect(screen.getByText(/Estos patrones no indican/)).toBeVisible();
    })
  ));
it("presents safe retry and loads the report after the server recovers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let failed = true;
      const respond = vi.fn(() =>
        failed
          ? Response.json({ private: "private financial failure" }, { status: 503 })
          : Response.json({ data: report, next: [] })
      );
      const { container } = mount(respond);
      const retry = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Reintentar" })
      );
      expect(container.textContent).not.toContain("private financial failure");
      const requestsBeforeRetry = respond.mock.calls.length;
      failed = false;
      fireEvent.click(retry);
      yield* Effect.tryPromise(() => screen.findByRole("list"));
      expect(respond.mock.calls.length).toBeGreaterThan(requestsBeforeRetry);
    })
  ));
