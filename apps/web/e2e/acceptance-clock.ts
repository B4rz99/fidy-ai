import { ResourceLimited } from "@fidy/server/client";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { Option, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

type ClockScope = {
  active: boolean;
  readonly tasks: Set<Promise<void>>;
  readonly failures: unknown[];
  readonly response: (response: Response) => void;
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
    return response
      .finished()
      .then(() =>
        scope.active
          ? advanceNativeRetry({ request: page.request, seconds: seconds.value })
          : undefined
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
  page.off("response", scope.response);
  installed.delete(page);
  return Promise.all(scope.tasks).then(() => {
    if (scope.failures.length > 0) {
      throw new AggregateError(scope.failures, "Acceptance clock failed");
    }
  });
};

/** Keep the application retry path and the real refusal; advance both sides of its cooldown. */
export const installAcceptanceClock = (page: Page): Promise<void> => {
  if (installed.has(page)) return Promise.resolve();
  const scope: ClockScope = {
    active: true,
    tasks: new Set(),
    failures: [],
    response: (response) => {
      const task = Promise.resolve()
        .then(() => advanceBrowserRetry(response, page, scope))
        .catch((cause: unknown) => {
          if (scope.active && !page.isClosed() && response.request().failure() === null) {
            scope.failures.push(cause);
          }
        })
        .finally(() => scope.tasks.delete(task));
      scope.tasks.add(task);
    },
  };
  installed.set(page, scope);
  return page.clock
    .install()
    .then(() => page.on("response", scope.response))
    .then(() => undefined);
};
