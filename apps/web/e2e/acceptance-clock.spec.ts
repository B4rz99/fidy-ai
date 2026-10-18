import { ResourceLimited } from "@fidy/server/client";
import type { APIResponse } from "@playwright/test";
import { Effect, Option, Schema } from "effect";
import { advanceNativeRetry } from "./acceptance-clock";
import { apiOrigin } from "./http-fixtures";
import { browserSessionHeaders, signInBudgetEditingThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const admissionProbeRequests = 12;
const admittedStatus = 200;
const resourceLimitedStatus = 429;
test("native admission still refuses the burst and recovers only after the fixture clock advances", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInBudgetEditingThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/auth/pair"));
      const headers = yield* Effect.tryPromise(() => browserSessionHeaders(page.request));
      let refusal = Option.none<APIResponse>();
      for (let attempt = 0; attempt < admissionProbeRequests; attempt++) {
        const result = yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        );
        if (result.status() === resourceLimitedStatus) {
          refusal = Option.some(result);
          break;
        }
        expect(result.status()).toBe(admittedStatus);
      }
      expect(Option.isSome(refusal)).toBe(true);
      const refused = Option.getOrThrow(refusal);
      expect(refused.headers()["retry-after"]).toBe("1");
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(
            yield* Effect.tryPromise(() => refused.json())
          )
        )
      ).toBe(true);
      expect(
        (yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        )).status()
      ).toBe(resourceLimitedStatus);
      yield* Effect.tryPromise(() => advanceNativeRetry({ request, seconds: 1 }));
      expect(
        (yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        )).status()
      ).toBe(admittedStatus);
    })
  ));
