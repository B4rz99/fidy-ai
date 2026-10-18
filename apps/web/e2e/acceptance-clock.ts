import { ResourceLimited } from "@fidy/server/client";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { Option, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

const installed = new WeakSet<Page>();
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
export const advanceNativeRetry = (request: APIRequestContext, seconds: number): Promise<void> =>
  request
    .post(`${operator}/clock/advance`, { data: { milliseconds: seconds * millisecondsPerSecond } })
    .then((response) => {
      if (response.status() !== successStatus) throw new Error("Acceptance clock advance failed");
    });

const advanceBrowserRetry = (
  response: Response,
  page: Page,
  request: APIRequestContext
): Promise<void> => {
  if (
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
      .then(() => advanceNativeRetry(request, seconds.value))
      .then(() => page.evaluate(() => Promise.resolve()))
      .then(() => page.clock.fastForward(seconds.value * millisecondsPerSecond));
  });
};

/** Keep the application retry path and the real refusal; advance both sides of its cooldown. */
export const installAcceptanceClock = (page: Page): Promise<void> => {
  if (installed.has(page)) return Promise.resolve();
  installed.add(page);
  return page.clock.install().then(() => {
    page.on("response", (response) =>
      advanceBrowserRetry(response, page, page.request).catch((cause: unknown) => {
        if (!page.isClosed() && response.request().failure() === null) throw cause;
      })
    );
  });
};
