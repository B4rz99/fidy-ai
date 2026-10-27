import type { Request } from "@playwright/test";
import { EventEmitter } from "node:events";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import {
  type ConsentRecoveryPage,
  observeConsentRecovery,
} from "../e2e/consent-recovery-diagnostics";

const { api } = browserAcceptanceTopology();
type RecoveryRequest = Pick<Request, "url" | "method">;
const fixture = (): Readonly<{
  events: EventEmitter;
  page: ConsentRecoveryPage;
  request: (path: string, method?: string, origin?: string) => RecoveryRequest;
}> => {
  const events = new EventEmitter();
  const page: ConsentRecoveryPage = {
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const request = (path: string, method = "GET", origin = api): RecoveryRequest => {
    const value = { url: (): string => `${origin}${path}`, method: (): string => method };
    events.emit("request", value);
    return value;
  };
  return { events, page, request };
};

it.effect(
  "Consent diagnostics project only closed metadata and retain the request's original stage",
  () =>
    Effect.gen(function* () {
      const { events, page, request } = fixture();
      const attachments: unknown[] = [];
      yield* Effect.gen(function* () {
        const diagnostic = yield* observeConsentRecovery({
          page,
          information: {
            attach: (_name, options) => {
              attachments.push(
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(options?.body)
              );
              return Promise.resolve();
            },
          },
        });
        const first = request("/web/consent?private=synthetic-secret");
        request("/private-unrecognized");
        request("/web/consent", "POST");
        request("/web/consent", "GET", "https://foreign.invalid");
        request("", "GET", "not-a-url");
        diagnostic.retry();
        const second = request("/web/consent");
        events.emit("response", { request: () => first, status: () => 503 });
        events.emit("response", { request: () => second, status: () => 200 });
        const failed = request("/user");
        events.emit("requestfailed", failed);
      }).pipe(Effect.scoped);
      expect(attachments).toEqual([
        [
          { stage: "leaving-review", resource: "consent", status: "requested" },
          { stage: "retry", resource: "consent", status: "requested" },
          { stage: "leaving-review", resource: "consent", status: 503 },
          { stage: "retry", resource: "consent", status: 200 },
          { stage: "retry", resource: "profile", status: "requested" },
          { stage: "retry", resource: "profile", status: "failed" },
        ],
      ]);
    })
);

it.effect("invalid Consent diagnostic metadata cannot escape or replace a successful journey", () =>
  Effect.gen(function* () {
    const { events, page, request } = fixture();
    let attachments = 0;
    const result = yield* Effect.gen(function* () {
      yield* observeConsentRecovery({
        page,
        information: {
          attach: () => {
            attachments++;
            return Promise.resolve();
          },
        },
      });
      const incoming = request("/web/consent");
      events.emit("response", { request: () => incoming, status: () => Number.NaN });
      return "original-success";
    }).pipe(Effect.scoped);
    expect(result).toBe("original-success");
    expect(attachments).toBe(0);
    expect(events.eventNames()).toEqual([]);
  })
);

it.effect("Consent diagnostics cap accumulation and detach all listeners before attachment", () =>
  Effect.gen(function* () {
    const { events, page, request } = fixture();
    const attachments: Array<ReadonlyArray<unknown>> = [];
    yield* Effect.gen(function* () {
      yield* observeConsentRecovery({
        page,
        information: {
          attach: (_name, options) => {
            expect(events.eventNames()).toEqual([]);
            request("/web/consent");
            attachments.push(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
                options?.body
              )
            );
            return Promise.resolve();
          },
        },
      });
      const overflow = 40;
      for (let index = 0; index < overflow; index++) request("/web/consent");
    }).pipe(Effect.scoped);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toHaveLength(32);
    expect(events.eventNames()).toEqual([]);
  })
);

it.effect.each(["rejected", "pending"] as const)(
  "Consent diagnostics preserve the original failure when attachment is %s",
  (mode) =>
    Effect.gen(function* () {
      const { events, page } = fixture();
      const started = yield* Deferred.make<void>();
      const context = yield* Effect.context<never>();
      const result = yield* Effect.gen(function* () {
        yield* observeConsentRecovery({
          page,
          information: {
            attach: () => {
              Effect.runSyncWith(context)(Deferred.succeed(started, undefined));
              return mode === "rejected"
                ? Promise.reject(new Error("Synthetic attachment refusal"))
                : Promise.withResolvers<void>().promise;
            },
          },
        });
        return yield* Effect.fail("original-consent-failure");
      }).pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      expect(events.eventNames()).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(result)).toEqual(Exit.fail("original-consent-failure"));
    })
);
