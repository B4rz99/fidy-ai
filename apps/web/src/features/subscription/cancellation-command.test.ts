// @vitest-environment jsdom
import { authenticationEndedEvent } from "@/session/authentication-channel";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { RegistryContext } from "@effect/atom-react";
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SubscriptionCancellationManagement } from "./cancellation";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import {
  type CancellationManagement,
  makeCancellationManagement,
  subscriptionStatusQuery,
} from "./cancellation-command";

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
const advance = (milliseconds: number): Promise<void> =>
  vi.advanceTimersByTimeAsync(milliseconds).then(() => undefined);
const flush = (): Promise<void> => advance(0);
type Fixture = Readonly<{
  requests: Array<string>;
  view: () => CancellationManagement;
  behavior: {
    postDelay: number;
    getDelay: number;
    postFails: boolean;
    getFails: boolean;
    cancellation: Option.Option<typeof cancellation>;
  };
  registry: AtomRegistry.AtomRegistry;
  resource: Atom.Atom<CancellationManagement>;
  passiveRefresh: () => void;
  dispose: () => void;
}>;
const fixture = (): Fixture => {
  vi.useFakeTimers();
  const requests: Array<string> = [];
  const behavior: Fixture["behavior"] = {
    postDelay: 0,
    getDelay: 0,
    postFails: false,
    getFails: false,
    cancellation: Option.none(),
  };
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.method);
        const failure = request.method === "POST" ? behavior.postFails : behavior.getFails;
        const body = failure
          ? {}
          : {
              data:
                request.method === "POST"
                  ? cancellation
                  : { ...standing, cancellation: Option.getOrNull(behavior.cancellation) },
              next: [],
            };
        return Effect.sleep(
          request.method === "POST" ? behavior.postDelay : behavior.getDelay
        ).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(body), {
                headers: { "content-type": "application/json" },
              })
            )
          )
        );
      })
    ),
  });
  const registry = AtomRegistry.make();
  const resource = makeCancellationManagement(client);
  cleanup.push(() => registry.dispose(), registry.mount(resource));
  const dispose = registry.get(resource).mount();
  cleanup.push(dispose);
  return {
    requests,
    behavior,
    registry,
    resource,
    dispose,
    passiveRefresh: () => registry.refresh(subscriptionStatusQuery(client)),
    view: (): CancellationManagement => registry.get(resource),
  };
};
it.effect(
  "consumes a review synchronously, rejects stale review callbacks and admits one cancellation",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      yield* Effect.tryPromise(flush);
      harness.view().review();
      const abandoned = harness.view();
      abandoned.back();
      abandoned.confirm();
      yield* Effect.tryPromise(flush);
      expect(harness.requests).toEqual(["GET"]);
      harness.view().review();
      const review = harness.view();
      review.confirm();
      review.confirm();
      review.refresh();
      yield* Effect.tryPromise(flush);
      expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
      expect(Option.getOrThrow(harness.view().cancellation).sourceCancellation).toBe("detached");
      expect(harness.requests.filter((method) => method === "GET")).toHaveLength(2);
    })
);

it.effect(
  "keeps a failed cancellation locked through passive reads and failed explicit recovery",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      yield* Effect.tryPromise(flush);
      harness.behavior.postFails = true;
      harness.view().review();
      harness.view().confirm();
      yield* Effect.tryPromise(flush);
      expect(harness.view().uncertain).toBe(true);
      harness.passiveRefresh();
      yield* Effect.tryPromise(flush);
      harness.view().review();
      harness.view().confirm();
      expect(harness.view().uncertain).toBe(true);
      harness.behavior.getFails = true;
      harness.view().refresh();
      yield* Effect.tryPromise(flush);
      expect(harness.view().uncertain).toBe(true);
      harness.behavior.getFails = false;
      harness.passiveRefresh();
      yield* Effect.tryPromise(flush);
      expect(harness.view().uncertain).toBe(true);
      harness.view().refresh();
      yield* Effect.tryPromise(flush);
      expect(harness.view().uncertain).toBe(false);
      harness.view().confirm();
      yield* Effect.tryPromise(flush);
      expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
      harness.view().review();
      harness.view().confirm();
      yield* Effect.tryPromise(flush);
      expect(harness.requests.filter((method) => method === "POST")).toHaveLength(2);
    })
);
it.effect(
  "retains acknowledged cancellation over delayed status and recovers provider evidence without replay",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      yield* Effect.tryPromise(flush);
      harness.behavior.postDelay = 50;
      harness.view().review();
      harness.view().confirm();
      yield* Effect.tryPromise(flush);
      harness.behavior.getDelay = 100;
      harness.passiveRefresh();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(50));
      const receipt = Option.getOrThrow(harness.view().cancellation);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(50));
      expect(harness.view().cancellation).toEqual(Option.some(receipt));
      harness.behavior.getDelay = 0;
      harness.behavior.cancellation = Option.some({
        ...cancellation,
        sourceCancellation: "voided",
      });
      harness.view().refresh();
      yield* Effect.tryPromise(flush);
      expect(Option.getOrThrow(harness.view().cancellation).sourceCancellation).toBe("voided");
      harness.view().review();
      harness.view().confirm();
      yield* Effect.tryPromise(flush);
      expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
    })
);
it.effect(
  "retires old confirmation callbacks and late results when the mounted owner is replaced",
  () =>
    Effect.gen(function* () {
      const harness = fixture();
      yield* Effect.tryPromise(flush);
      harness.behavior.postDelay = 100;
      harness.view().review();
      const review = harness.view();
      review.confirm();
      yield* Effect.tryPromise(flush);
      harness.dispose();
      cleanup.push(harness.view().mount());
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(100));
      review.confirm();
      review.refresh();
      expect(Option.isNone(harness.view().cancellation)).toBe(true);
      expect(harness.view().uncertain).toBe(true);
      expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
    })
);
it.effect("keeps mounted review admission and keyboard focus through React updates", () =>
  Effect.gen(function* () {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const harness = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    });
    yield* Effect.tryPromise(() =>
      act(() => {
        root.render(
          createElement(
            StrictMode,
            {},
            createElement(
              RegistryContext.Provider,
              { value: harness.registry },
              createElement(SubscriptionCancellationManagement, { command: harness.resource })
            )
          )
        );
        return flush();
      })
    );
    const button = (text: string): HTMLButtonElement => {
      const found = Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent === text
      );
      if (found === undefined) throw new Error("Missing cancellation action");
      return found;
    };
    act(() => button("Cancelar renovaciones futuras").click());
    expect(document.activeElement?.textContent).toBe("¿Cancelar renovaciones futuras?");
    act(() => button("Conservar renovaciones").click());
    expect(document.activeElement?.textContent).toBe("Cancelar renovaciones futuras");
    act(() => button("Cancelar renovaciones futuras").click());
    harness.behavior.postDelay = 100;
    yield* Effect.tryPromise(() =>
      act(() => {
        button("Confirmar cancelación").click();
        return flush();
      })
    );
    expect(container.textContent).toContain("Cancelando renovaciones…");
    expect(container.textContent).toContain("25 de noviembre de 2026");
    expect(document.activeElement?.textContent).toBe("Cancelando renovaciones…");
    expect(button("Confirmar cancelación").disabled).toBe(true);
    expect(button("Consultar cancelación").disabled).toBe(true);
    yield* Effect.tryPromise(() => act(() => advance(100)));
    expect(container.textContent).toContain("Renovaciones canceladas");
    expect(container.textContent).toContain("25 de noviembre de 2026");
    expect(harness.requests.filter((method) => method === "POST")).toHaveLength(1);
  })
);

it.effect("recovers a lost response from retained evidence on fresh load without replay", () =>
  Effect.gen(function* () {
    const original = fixture();
    yield* Effect.tryPromise(flush);
    original.behavior.postFails = true;
    original.view().review();
    original.view().confirm();
    yield* Effect.tryPromise(flush);
    expect(original.view().uncertain).toBe(true);
    const reloaded = fixture();
    reloaded.behavior.cancellation = Option.some(cancellation);
    reloaded.passiveRefresh();
    yield* Effect.tryPromise(flush);
    expect(Option.getOrThrow(reloaded.view().cancellation).sourceCancellation).toBe("detached");
    reloaded.view().review();
    reloaded.view().confirm();
    yield* Effect.tryPromise(flush);
    expect(original.requests.filter((method) => method === "POST")).toHaveLength(1);
    expect(reloaded.requests.every((method) => method === "GET")).toBe(true);
  })
);
it.effect("ends cancellation publication and old actions on authentication replacement", () =>
  Effect.gen(function* () {
    const original = fixture();
    yield* Effect.tryPromise(flush);
    original.behavior.postDelay = 100;
    original.view().review();
    const reviewed = original.view();
    reviewed.confirm();
    yield* Effect.tryPromise(flush);
    window.dispatchEvent(new Event(authenticationEndedEvent));
    const replacement = fixture();
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(100));
    reviewed.confirm();
    reviewed.refresh();
    original.view().refresh();
    expect(Option.isNone(original.view().cancellation)).toBe(true);
    expect(Option.isNone(replacement.view().cancellation)).toBe(true);
    expect(original.requests.filter((method) => method === "POST")).toHaveLength(1);
    expect(replacement.requests.every((method) => method === "GET")).toBe(true);
  })
);
