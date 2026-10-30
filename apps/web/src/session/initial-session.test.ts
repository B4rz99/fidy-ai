import { loadBrowserSessionEntry } from "@/transport/session-binding";
import { beginInitialBrowserSession } from "@/transport/initial-session";
import { afterEach, expect, it, vi } from "vitest";
import { Effect, Exit, Option } from "effect";
import { authenticationEndedEvent } from "./authentication-channel";
import {
  type InitialBrowserRequest,
  beginInitialBrowserRequest as prepare,
} from "@/transport/initial-request";
import { observeInitialBrowserRequest } from "./initial-request";

const beginInitialBrowserRequest = (origin: string, context: boolean): InitialBrowserRequest =>
  observeInitialBrowserRequest(prepare(origin, context));

const origin = "https://api.test.fidyapp.com";
const first = "20000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const granted = {
  binding: first,
  initial: {
    status: "Granted",
    withdrawal: null,
    profile: {
      data: {
        id: "10000000-0000-4000-8000-000000000001",
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        createdAt: "2026-01-01T00:00:00.000Z",
        trialPeriod: { startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-08T00:00:00.000Z" },
      },
      categories: [],
      next: [],
    },
  },
};
afterEach(() => vi.unstubAllGlobals());

it("drops all prepared private context when the current cookie's binding changed before adoption", async () => {
  const network = vi
    .fn()
    .mockResolvedValueOnce(Response.json(granted))
    .mockResolvedValueOnce(Response.json({ binding: second }));
  vi.stubGlobal("fetch", network);
  const request = beginInitialBrowserRequest(origin, true);
  const initial = beginInitialBrowserSession({ ...request, request });
  try {
    await initial.ready;
    const result = Effect.runSync(Option.getOrThrow(initial.take({})).result);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.binding).toBe(second);
      expect(Option.isNone(result.value.initial)).toBe(true);
    }
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    initial.cancel();
  }
});

it("an authentication transition before mount retires even an already-fulfilled prepared response", async () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(granted)));
  const request = beginInitialBrowserRequest(origin, true);
  await request.result;
  window.dispatchEvent(new Event(authenticationEndedEvent));
  const initial = beginInitialBrowserSession({ ...request, request });
  try {
    await initial.ready;
    expect(Option.isNone(initial.take({}))).toBe(true);
    expect(request.signal.aborted).toBe(true);
  } finally {
    initial.cancel();
  }
});

it("only the same mounted observer may replay a prepared observation; another epoch cannot adopt it", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(granted))
      .mockResolvedValueOnce(Response.json({ binding: first }))
  );
  const request = beginInitialBrowserRequest(origin, true);
  const initial = beginInitialBrowserSession({ ...request, request });
  try {
    await initial.ready;
    const owner = {};
    const work = initial.take(owner);
    expect(Option.isSome(work)).toBe(true);
    expect(initial.take(owner)).toEqual(work);
    expect(Option.isNone(initial.take({}))).toBe(true);
    expect(Option.isNone(initial.take(owner))).toBe(true);
  } finally {
    initial.cancel();
  }
});

it("retires a completed synchronous handoff when authentication changes before adoption", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(granted)))
  );
  const request = beginInitialBrowserRequest(origin, true);
  const initial = beginInitialBrowserSession({ ...request, request });
  try {
    await initial.ready;
    window.dispatchEvent(new Event(authenticationEndedEvent));
    expect(Option.isNone(initial.take({}))).toBe(true);
    expect(request.signal.aborted).toBe(true);
  } finally {
    initial.cancel();
  }
});

it("also rechecks the current cookie when private entry has no prepared request", async () => {
  const network = vi
    .fn()
    .mockResolvedValueOnce(Response.json(granted))
    .mockResolvedValueOnce(Response.json({ binding: second }));
  vi.stubGlobal("fetch", network);
  const entry = await Effect.runPromise(
    loadBrowserSessionEntry({
      apiOrigin: origin,
      context: true,
      request: Option.none(),
    })
  );
  expect(entry.binding).toBe(second);
  expect(Option.isNone(entry.initial)).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
});
