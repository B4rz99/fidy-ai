import { Effect, Option } from "effect";
import { type Mock, afterEach, expect, it, vi } from "vitest";
import { authenticationEndedEvent } from "./authentication-events";
import { beginInitialBrowserRequest } from "@/transport/initial-request";
import { beginInitialBrowserSession } from "@/transport/initial-session";
import { type BindingState, observeBinding } from "./session-observer";

const origin = "https://api.test.fidyapp.com";
const binding = "20000000-0000-4000-8000-000000000001";
const bootstrapHttp = vi.fn<typeof globalThis.fetch>();
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
type PreparedView = Readonly<{
  network: Mock<typeof globalThis.fetch>;
  initial: ReturnType<typeof beginInitialBrowserSession>;
  request: ReturnType<typeof beginInitialBrowserRequest>;
}>;
type ObserverView = PreparedView &
  Readonly<{
    update: Mock<(state: BindingState) => void>;
    expired: Mock<() => void>;
    failed: Mock<() => void>;
    dispose: () => void;
  }>;
const lastUpdate = (view: ObserverView): BindingState =>
  Option.getOrThrow(Option.fromUndefinedOr(view.update.mock.calls.at(-1)?.[0]));
const prepareView = (response: Mock<typeof globalThis.fetch>): PreparedView => {
  const network = bootstrapHttp.mockReset().mockImplementation(response);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { pathname: "/app/transactions" }, Uint8Array })
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", network);
  const request = beginInitialBrowserRequest({
    apiOrigin: origin,
    context: false,
    transactions: false,
  });
  const initial = beginInitialBrowserSession({ apiOrigin: origin, context: false, request });
  return { network, initial, request };
};
const observeView = (prepared: PreparedView): ObserverView => {
  const update = vi.fn<(state: BindingState) => void>();
  const expired = vi.fn<() => void>();
  const failed = vi.fn<() => void>();
  const dispose = observeBinding({
    apiOrigin: origin,
    initial: prepared.initial,
    owner: {},
    update,
    expired,
    failed,
  });
  disposals.push(dispose);
  return { ...prepared, update, expired, failed, dispose };
};
const attach = (initialBinding: Option.Option<string>): Promise<ObserverView> => {
  const prepared = prepareView(
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ binding: Option.getOrNull(initialBinding) }))
  );
  return prepared.initial.ready.then(() => observeView(prepared));
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

for (const replacement of ["20000000-0000-4000-8000-000000000002", null]) {
  it(`retires protected work before expiry when the current binding becomes ${replacement ?? "anonymous"}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const view = yield* Effect.tryPromise(() => attach(Option.some(binding)));
        const entry = lastUpdate(view);
        view.expired.mockImplementation(() => {
          expect(entry.session.signal.aborted).toBe(true);
          expect(view.request.signal.aborted).toBe(true);
        });
        view.network.mockResolvedValue(Response.json({ binding: replacement }));
        entry.session.recheck();
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(view.expired).toHaveBeenCalledOnce())
        );
        expect(view.update).toHaveBeenCalledTimes(2);
        expect(lastUpdate(view).session).toBe(entry.session);
        expect(lastUpdate(view).initial).toBe(entry.initial);
        expect(view.failed).not.toHaveBeenCalled();
        entry.session.recheck();
        document.dispatchEvent(new Event("visibilitychange"));
        yield* Effect.yieldNow;
        expect(view.network).toHaveBeenCalledTimes(2);
      })
    ));
}

it("coalesces wake bursts while the initial public observation is pending", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reply = Promise.withResolvers<Response>();
      const prepared = prepareView(
        vi.fn<typeof globalThis.fetch>().mockImplementation(() => reply.promise)
      );
      const view = observeView(prepared);
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(view.update).not.toHaveBeenCalled();
      expect(view.network).toHaveBeenCalledOnce();
      reply.resolve(Response.json({ binding: null }));
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(view.update).toHaveBeenCalledOnce()));
      expect(lastUpdate(view).session.binding).toBe("none");
      yield* Effect.yieldNow;
      expect(view.network).toHaveBeenCalledOnce();
      expect(view.failed).not.toHaveBeenCalled();
    })
  ));

it("closes an unavailable initial observation without admitting anonymous children or retrying", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepared = prepareView(
        vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ binding: 42 }))
      );
      const view = observeView(prepared);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(view.failed).toHaveBeenCalledOnce()));
      expect(view.update).not.toHaveBeenCalled();
      expect(view.expired).not.toHaveBeenCalled();
      expect(view.request.signal.aborted).toBe(true);
      expect(Option.isNone(view.initial.take({}))).toBe(true);
      document.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.yieldNow;
      expect(view.network).toHaveBeenCalledOnce();
    })
  ));

it("retires the original lifetime when a resumed binding read is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* Effect.tryPromise(() => attach(Option.some(binding)));
      const entry = lastUpdate(view);
      view.failed.mockImplementation(() => {
        expect(entry.session.signal.aborted).toBe(true);
        expect(view.request.signal.aborted).toBe(true);
      });
      view.network.mockResolvedValue(Response.json({ binding: 42 }));
      entry.session.recheck();
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(view.failed).toHaveBeenCalledOnce()));
      expect(view.expired).not.toHaveBeenCalled();
      expect(view.update).toHaveBeenCalledTimes(2);
      entry.session.recheck();
      document.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.yieldNow;
      expect(view.network).toHaveBeenCalledTimes(2);
    })
  ));

const settleReply = (reply: PromiseWithResolvers<Response>, failed: boolean): void => {
  if (failed) reply.reject(new Error("Late bootstrap failure"));
  else reply.resolve(Response.json({ binding }));
};

for (const resumed of [false, true]) {
  for (const authenticationEnded of [false, true]) {
    for (const failedReply of [false, true]) {
      it(`ignores late ${failedReply ? "failure" : "success"} after ${authenticationEnded ? "authentication ends" : "disposal"} during ${resumed ? "resume" : "initial admission"}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const reply = Promise.withResolvers<Response>();
            const view = resumed
              ? yield* Effect.tryPromise(() => attach(Option.some(binding)))
              : observeView(
                  prepareView(
                    vi.fn<typeof globalThis.fetch>().mockImplementation(() => reply.promise)
                  )
                );
            const published = Option.fromUndefinedOr(view.update.mock.calls.at(-1)?.[0]);
            if (resumed) {
              view.network.mockImplementation(() => reply.promise);
              Option.getOrThrow(published).session.recheck();
            }
            const reads = resumed ? 2 : 1;
            yield* Effect.tryPromise(() =>
              vi.waitFor(() => expect(view.network).toHaveBeenCalledTimes(reads))
            );
            const pendingSignal = Option.getOrThrow(
              Option.fromNullishOr(view.network.mock.calls.at(-1)?.[1]?.signal)
            );
            if (authenticationEnded) window.dispatchEvent(new Event(authenticationEndedEvent));
            else view.dispose();
            expect(pendingSignal.aborted).toBe(true);
            expect(view.request.signal.aborted).toBe(true);
            Option.map(published, (entry) => expect(entry.session.signal.aborted).toBe(true));
            const publications = view.update.mock.calls.length;
            settleReply(reply, failedReply);
            document.dispatchEvent(new Event("visibilitychange"));
            Option.map(published, (entry) => entry.session.recheck());
            yield* Effect.yieldNow;
            expect(view.update).toHaveBeenCalledTimes(publications);
            expect(view.expired).not.toHaveBeenCalled();
            expect(view.failed).not.toHaveBeenCalled();
            expect(view.network).toHaveBeenCalledTimes(reads);
          })
        ));
    }
  }
}
