import { ResourceLimited } from "@fidy/server/client";
import type {
  APIRequestContext,
  APIResponse,
  Frame,
  Page,
  Request,
  Response,
} from "@playwright/test";
import { Option, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

type ClockScope = {
  active: boolean;
  generation: number;
  readonly navigation: (frame: Frame) => void;
  readonly tasks: Set<Promise<void>>;
  readonly failures: Array<Readonly<{ generation: number; cause: unknown }>>;
  readonly finished: (request: Request) => void;
};
const installed = new WeakMap<Page, ClockScope>();
const successStatus = 204;
const millisecondsPerSecond = 1_000;
const maximumRetrySeconds = 5;
const resourceLimitedStatus = 429;
const { api, operator } = browserAcceptanceTopology();
const RetrySeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximumRetrySeconds)
);

/** Advance the loopback process clock instead of waiting through an explicitly refused request. */
export const advanceNativeRetry = ({
  request,
  seconds,
}: Readonly<{ request: APIRequestContext; seconds: number }>): Promise<void> =>
  request
    .post(`${operator}/clock/advance`, { data: { milliseconds: seconds * millisecondsPerSecond } })
    .then((response) => {
      if (response.status() !== successStatus) throw new Error("Acceptance clock advance failed");
    });

/** Only a controlled, decoded non-admission permits advancing time before retrying a probe. */
export const advanceRefusedRequest = ({
  response,
  request,
}: Readonly<{ response: APIResponse; request: APIRequestContext }>): Promise<boolean> => {
  if (
    response.status() !== resourceLimitedStatus ||
    response.headers()["x-acceptance-clock"] !== "controlled"
  ) {
    return Promise.resolve(false);
  }
  const seconds = Schema.decodeUnknownOption(RetrySeconds)(response.headers()["retry-after"]);
  if (Option.isNone(seconds)) return Promise.resolve(false);
  return response
    .json()
    .then((body: unknown) =>
      Option.isNone(Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(body))
        ? false
        : advanceNativeRetry({ request, seconds: seconds.value }).then(() => true)
    );
};

/** Advance an explicitly observed polling delay in the native fixture and the browser. */
export const advanceAcceptancePoll = ({
  page,
  milliseconds,
}: Readonly<{ page: Page; milliseconds: number }>): Promise<void> =>
  page.request
    .post(`${operator}/clock/advance`, { data: { milliseconds } })
    .then((response) => {
      if (response.status() !== successStatus) throw new Error("Acceptance clock advance failed");
    })
    .then(() => page.clock.fastForward(milliseconds));

const advanceBrowserRetry = (response: Response, page: Page, scope: ClockScope): Promise<void> => {
  if (
    !scope.active ||
    page.isClosed() ||
    response.status() !== resourceLimitedStatus ||
    !response.url().startsWith(`${api}/`) ||
    response.headers()["x-acceptance-clock"] !== "controlled"
  ) {
    return Promise.resolve();
  }
  const seconds = Schema.decodeUnknownOption(RetrySeconds)(response.headers()["retry-after"]);
  if (Option.isNone(seconds)) return Promise.resolve();
  return response.json().then((body: unknown) => {
    if (Option.isNone(Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(body))) {
      return;
    }
    return (
      scope.active
        ? advanceNativeRetry({ request: page.request, seconds: seconds.value })
        : Promise.resolve()
    )
      .then(() => (scope.active ? page.evaluate(() => Promise.resolve()) : undefined))
      .then(() =>
        scope.active ? page.clock.fastForward(seconds.value * millisecondsPerSecond) : undefined
      );
  });
};

/** Stop scheduling before fixture teardown, then settle every callback while its context is owned. */
export const disposeAcceptanceClock = (page: Page): Promise<void> => {
  const scope = installed.get(page);
  if (scope === undefined) return Promise.resolve();
  scope.active = false;
  page.off("requestfinished", scope.finished);
  page.off("framenavigated", scope.navigation);
  installed.delete(page);
  return Promise.all(scope.tasks).then(() => {
    const failures = scope.failures.filter(
      ({ generation, cause }) =>
        generation === scope.generation ||
        !(cause instanceof Error && cause.message.includes("Execution context was destroyed"))
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ cause }) => cause),
        "Acceptance clock failed"
      );
    }
  });
};

/** Keep the application retry path and the real refusal; advance both sides of its cooldown. */
export const installAcceptanceClock = (page: Page): Promise<void> => {
  if (installed.has(page)) return Promise.resolve();
  const scope: ClockScope = {
    active: true,
    generation: 0,
    navigation: (frame) => {
      if (frame === page.mainFrame()) scope.generation++;
    },
    tasks: new Set(),
    failures: [],
    finished: (request) => {
      if (!request.url().startsWith(`${api}/`)) return;
      const generation = scope.generation;
      const task = request
        .response()
        .then((response) =>
          response === null ? undefined : advanceBrowserRetry(response, page, scope)
        )
        .catch((cause: unknown) => {
          if (
            scope.active &&
            generation === scope.generation &&
            !page.isClosed() &&
            request.failure() === null
          ) {
            scope.failures.push({ generation, cause });
          }
        })
        .finally(() => scope.tasks.delete(task));
      scope.tasks.add(task);
    },
  };
  installed.set(page, scope);
  return page.clock
    .install()
    .then(() => {
      // Playwright emits this after the body downloads; aborted navigations cannot strand body reads.
      page.on("requestfinished", scope.finished);
      page.on("framenavigated", scope.navigation);
    })
    .then(() => undefined);
};

/** Keep native high-resolution timing while virtualizing cooldown and polling timers. */
export const installAcceptanceClockWithNativePerformance = (page: Page): Promise<void> => {
  if (installed.has(page)) {
    return Promise.reject(new Error("Performance clock must be captured before installation"));
  }
  return page
    .evaluate(() => {
      const nativePerformance = performance;
      Reflect.defineProperty(globalThis, "__fidyRestoreNativePerformance", {
        configurable: true,
        value: () => {
          Reflect.defineProperty(globalThis, "performance", {
            configurable: true,
            value: nativePerformance,
          });
          Reflect.deleteProperty(globalThis, "__fidyRestoreNativePerformance");
        },
      });
    })
    .then(() => installAcceptanceClock(page))
    .then(() =>
      page.evaluate(() => {
        const restore: unknown = Reflect.get(globalThis, "__fidyRestoreNativePerformance");
        if (typeof restore !== "function") throw new Error("Native performance clock was lost");
        Reflect.apply(restore, globalThis, []);
      })
    );
};
