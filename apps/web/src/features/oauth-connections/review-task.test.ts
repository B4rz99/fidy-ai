// @vitest-environment jsdom

import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { OAuthReview, makeWebAuthClient } from "@/transport/client";
import {
  type ReviewTaskActions,
  type ReviewTaskState,
  initialReviewSelection,
  makeReviewTask,
} from "./review-task";

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((dispose) => dispose());
  resources.length = 0;
  vi.useRealTimers();
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const requestId = "10000000-0000-4000-8000-000000000001";
const callback = "http://127.0.0.1:3456/callback?code=one-use-callback&state=reviewed-state";
const review = Schema.decodeSync(OAuthReview)({
  requestId,
  claimedClientName: "Agente",
  scopes: ["read"],
  permissions: [{ scope: "read", label: "Leer", description: "Consultar" }],
  reviewedAt: "2026-11-10T13:00:00Z",
  requestExpiresAt: "2026-11-10T13:15:00Z",
  connectAvailable: true,
});
type Reply = Readonly<{ body: Schema.Json; status: number; wait: Promise<void> }>;
const approved: Reply = {
  body: { connectionId: requestId, callback },
  status: 200,
  wait: Promise.resolve(),
};
const fixture = (
  navigate: (destination: string) => void,
  replies: ReadonlyArray<Reply> = [approved]
): Readonly<{
  task: ReturnType<typeof makeReviewTask>;
  registry: AtomRegistry.AtomRegistry;
  sent: Array<string>;
  state: () => ReviewTaskState;
  actions: () => ReviewTaskActions;
  dispose: () => void;
  mount: () => void;
}> => {
  vi.useFakeTimers();
  const sent: Array<string> = [];
  const http = HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    const reply = replies[sent.length] ?? approved;
    sent.push(path);
    return Effect.tryPromise({
      try: () => reply.wait,
      catch: () =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "synthetic unavailable response",
          }),
        }),
    }).pipe(
      Effect.as(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          })
        )
      )
    );
  });
  const client = makeWebAuthClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  });
  let state: ReviewTaskState = initialReviewSelection(review);
  const options = {
    client,
    initial: initialReviewSelection(review),
    onChange: (next: ReviewTaskState): void => {
      state = next;
    },
    navigate,
  };
  state = options.initial;
  const task = makeReviewTask(options);
  const registry = AtomRegistry.make();
  const dispatch: Parameters<typeof task.actions>[1] = (decision) =>
    registry.set(task.atom, decision);
  let unmount = task.mount();
  resources.push(
    () => registry.dispose(),
    registry.mount(task.atom),
    () => unmount()
  );
  return {
    task,
    dispose: (): void => unmount(),
    mount: (): void => {
      unmount = task.mount();
    },
    registry,
    sent,
    state: (): ReviewTaskState => state,
    actions: (): ReviewTaskActions => task.actions(state, dispatch),
  };
};

it.effect(
  "keeps a decoded approval unresolved when exact callback navigation throws without replay or disclosure",
  () =>
    Effect.gen(function* () {
      const assigned: Array<string> = [];
      const current = fixture((destination) => {
        assigned.push(destination);
        throw new Error(destination);
      });
      const retained = current.actions();
      retained.connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(assigned).toEqual([callback]);
      expect(current.state()).toEqual({ _tag: "Uncertain" });
      retained.connect();
      current.actions().connect();
      current.actions().cancel();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.sent).toEqual(["/web/oauth/connect"]);
      expect(encodeJson(current.registry.get(current.task.atom))).not.toContain("one-use-callback");
      expect(encodeJson(current.state())).not.toContain("one-use-callback");
    })
);

it.effect(
  "retired review owners cannot redirect a replacement mount after an already submitted approval settles",
  () =>
    Effect.gen(function* () {
      const { promise: wait, resolve: release } = Promise.withResolvers<void>();
      const assigned: Array<string> = [];
      const current = fixture(
        (destination) => {
          assigned.push(destination);
        },
        [{ ...approved, wait }]
      );
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.sent).toEqual(["/web/oauth/connect"]);
      current.dispose();
      current.mount();
      release();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(assigned).toEqual([]);
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.sent).toEqual(["/web/oauth/connect"]);
    })
);

for (const event of ["pagehide", "fidy:authentication-ended"]) {
  it.effect(`retirement on ${event} fences late approval navigation before React unmount`, () =>
    Effect.gen(function* () {
      const { promise: wait, resolve: release } = Promise.withResolvers<void>();
      const assigned: Array<string> = [];
      const current = fixture(
        (destination) => {
          assigned.push(destination);
        },
        [{ ...approved, wait }]
      );
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      window.dispatchEvent(new Event(event));
      release();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(assigned).toEqual([]);
      expect(current.sent).toEqual(["/web/oauth/connect"]);
    })
  );
}

it.effect(
  "fresh eligibility requires a new explicit decision and never revives captured actions from the old review",
  () =>
    Effect.gen(function* () {
      const assigned: Array<string> = [];
      const current = fixture(
        (destination) => {
          assigned.push(destination);
        },
        [
          { body: { error: "temporarily_unavailable" }, status: 503, wait: Promise.resolve() },
          {
            body: yield* Schema.encodeEffect(OAuthReview)(review),
            status: 200,
            wait: Promise.resolve(),
          },
          approved,
        ]
      );
      const retired = current.actions();
      retired.cancel();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      current.actions().readAgain();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      retired.connect();
      retired.cancel();
      retired.toggle("read", false);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.sent).toEqual(["/web/oauth/cancel", "/web/oauth/review"]);
      expect(assigned).toEqual([]);
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.sent).toEqual([
        "/web/oauth/cancel",
        "/web/oauth/review",
        "/web/oauth/connect",
      ]);
      expect(assigned).toEqual([callback]);
    })
);

it.effect(
  "normal callback assignment remains a one-way handoff without token exchange or retained callback material",
  () =>
    Effect.gen(function* () {
      const assigned: Array<string> = [];
      const current = fixture((destination) => {
        assigned.push(destination);
      });
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      current.actions().connect();
      current.actions().readAgain();
      current.actions().cancel();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(assigned).toEqual([callback]);
      expect(current.sent).toEqual(["/web/oauth/connect"]);
      expect(current.state()).toEqual({ _tag: "Redirecting" });
      expect(encodeJson(current.state())).not.toContain("one-use-callback");
      expect(encodeJson(current.registry.get(current.task.atom))).not.toContain("one-use-callback");
    })
);

it.effect("a malformed approval result cannot navigate or permit another approval", () =>
  Effect.gen(function* () {
    const assigned: Array<string> = [];
    const current = fixture(
      (destination) => {
        assigned.push(destination);
      },
      [{ body: { connectionId: requestId }, status: 200, wait: Promise.resolve() }]
    );
    current.actions().connect();
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    current.actions().connect();
    current.actions().readAgain();
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
    expect(assigned).toEqual([]);
    expect(current.sent).toEqual(["/web/oauth/connect"]);
    expect(current.state()).toEqual({ _tag: "Uncertain" });
  })
);

it.effect(
  "a fresh eligibility response from a retired mount cannot restore action-ready review",
  () =>
    Effect.gen(function* () {
      const { promise: wait, resolve: release } = Promise.withResolvers<void>();
      const current = fixture(
        () => undefined,
        [
          { body: { error: "temporarily_unavailable" }, status: 503, wait: Promise.resolve() },
          { body: yield* Schema.encodeEffect(OAuthReview)(review), status: 200, wait },
        ]
      );
      current.actions().cancel();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      current.actions().readAgain();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      current.dispose();
      current.mount();
      release();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      current.actions().connect();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(current.state()).toEqual({ _tag: "Unavailable" });
      expect(current.sent).toEqual(["/web/oauth/cancel", "/web/oauth/review"]);
    })
);
