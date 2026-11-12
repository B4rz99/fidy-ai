import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { type CancellationManagement, makeCancellationManagement } from "./cancellation-command";

const paid = {
  priceId: "15520000-0000-4000-8000-000000000011",
  money: { amount: "28900", currency: "COP" },
  billingPeriod: "monthly",
  serviceMarket: "CO",
  taxTreatment: "not-taxable",
  startsAt: "2026-10-25T14:00:00Z",
  endsAt: "2026-11-25T14:00:00Z",
  renewalAnchor: "2026-10-25T14:00:00Z",
};
const cancellation = {
  cancelledAt: "2026-11-02T15:00:00Z",
  paidThrough: paid.endsAt,
  sourceCancellation: "detached",
};
const standing = {
  accessTier: "pro",
  hasProGrant: false,
  trialPeriod: { startedAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-08T00:00:00Z" },
  paidSubscription: paid,
  cancellation: null,
  recentAttempts: [],
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.useRealTimers();
});
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0);
const fixture = (): Readonly<{ requests: Array<string>; view: () => CancellationManagement }> => {
  vi.useFakeTimers();
  const requests: Array<string> = [];
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.method);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                data: request.method === "POST" ? cancellation : standing,
                next: [],
              }),
              { headers: { "content-type": "application/json" } }
            )
          )
        );
      })
    ),
  });
  const registry = AtomRegistry.make();
  const resource = makeCancellationManagement(client);
  cleanup.push(() => registry.dispose(), registry.mount(resource));
  cleanup.push(registry.get(resource).mount());
  return { requests, view: (): CancellationManagement => registry.get(resource) };
};
it("consumes a review synchronously, rejects stale review callbacks and admits one cancellation", async () => {
  const harness = fixture();
  await flush();
  harness.view().review();
  const abandoned = harness.view();
  abandoned.back();
  abandoned.confirm();
  await flush();
  expect(harness.requests).toEqual(["GET"]);
  harness.view().review();
  const review = harness.view();
  review.confirm();
  review.confirm();
  review.refresh();
  await flush();
  expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
  expect(Option.getOrThrow(harness.view().cancellation).sourceCancellation).toBe("detached");
});
