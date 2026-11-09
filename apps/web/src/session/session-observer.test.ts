import { Effect, Option } from "effect";
import { type Mock, afterEach, expect, it, vi } from "vitest";
import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { beginInitialBrowserSession } from "@/transport/initial-session";
import { type BindingState, observeBinding } from "./session-observer";

const origin = "https://api.test.fidyapp.com";
const binding = "20000000-0000-4000-8000-000000000001";
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
type ObserverView = Readonly<{
  network: Mock<typeof globalThis.fetch>;
  update: Mock<(state: BindingState) => void>;
}>;
const lastUpdate = (view: ObserverView): BindingState =>
  Option.getOrThrow(Option.fromUndefinedOr(view.update.mock.calls.at(-1)?.[0]));
const attach = (initialBinding: Option.Option<string>): Promise<ObserverView> => {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { pathname: "/app/transactions" }, Uint8Array })
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  const network = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ binding: Option.getOrNull(initialBinding) }));
  vi.stubGlobal("fetch", network);
  const request = beginInitialBrowserRequest({
    apiOrigin: origin,
    context: false,
    transactions: false,
  });
  const initial = beginInitialBrowserSession({ apiOrigin: origin, context: false, request });
  return initial.ready.then(() => {
    const update = vi.fn<(state: BindingState) => void>();
    const dispose = observeBinding({
      apiOrigin: origin,
      initial,
      owner: {},
      update,
      expired: vi.fn(),
      failed: vi.fn(),
    });
    disposals.push(dispose);
    return { network, update };
  });
};

it("admits an anonymous observation as a valid initial binding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* Effect.tryPromise(() => attach(Option.none()));
      const entry = lastUpdate(view);
      expect(entry.session.binding).toBe("none");
      expect(Option.isNone(entry.initial.initial)).toBe(true);
      expect(entry.session.signal.aborted).toBe(false);
      expect(view.network).toHaveBeenCalledTimes(1);
    })
  ));

it("coalesces wake bursts and retains the original lifetime and receipt after same-binding resume", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* Effect.tryPromise(() => attach(Option.some(binding)));
      const entry = lastUpdate(view);
      const reply = Promise.withResolvers<Response>();
      view.network.mockImplementation(() => reply.promise);
      entry.session.recheck();
      const restored = new Event("pageshow");
      Object.defineProperty(restored, "persisted", { value: true });
      window.dispatchEvent(restored);
      document.dispatchEvent(new Event("visibilitychange"));
      entry.session.recheck();
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(view.network).toHaveBeenCalledTimes(2))
      );
      const checking = lastUpdate(view);
      expect(checking.checking).toBe(true);
      expect(checking.session).toBe(entry.session);
      expect(checking.initial).toBe(entry.initial);
      reply.resolve(Response.json({ binding }));
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(lastUpdate(view).checking).toBe(false))
      );
      const retained = lastUpdate(view);
      expect(retained.session).toBe(entry.session);
      expect(retained.initial).toBe(entry.initial);
      expect(retained.initial.receivedAt).toBe(entry.initial.receivedAt);
      expect(entry.session.signal.aborted).toBe(false);
      yield* Effect.yieldNow;
      expect(view.network).toHaveBeenCalledTimes(2);
      expect(view.network.mock.calls[1]?.[0]).toEqual(new URL(`${origin}/web/session/binding`));
    })
  ));
