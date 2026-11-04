import { DashboardAssessmentConfiguration } from "../../server/cloudflare/browser-acceptance/contract";
import type { APIRequestContext } from "@playwright/test";
import { Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

const { expect } = playwright;
const { operator: operatorOrigin } = browserAcceptanceTopology();
const AssessmentPreparation = Schema.Struct({
  status: Schema.Literals(["unprepared", "preparing", "ready", "failed"]),
});
const assessmentPreparation = (
  request: APIRequestContext
): Promise<typeof AssessmentPreparation.Type> =>
  request
    .get(`${operatorOrigin}/assessment/prepare`)
    .then((response) => {
      expect(response.ok()).toBeTruthy();
      return response.json();
    })
    .then(Schema.decodeUnknownSync(AssessmentPreparation));

export const prepareAssessmentFixture = ({
  request,
}: Readonly<{ request: APIRequestContext }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Effect.tryPromise(() =>
        request.post(`${operatorOrigin}/assessment/prepare`)
      );
      expect(started.ok()).toBeTruthy();
      let preparation = yield* Effect.tryPromise(() => assessmentPreparation(request));
      while (preparation.status === "preparing") {
        yield* Effect.sleep("500 millis");
        preparation = yield* Effect.tryPromise(() => assessmentPreparation(request));
      }
      expect(preparation.status).toBe("ready");
    })
  );

const PreparedAssessment = Schema.Struct({
  status: Schema.Literal("ready"),
  configuration: DashboardAssessmentConfiguration,
  layoutDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const readPreparedAssessment = (
  input: Readonly<{ request: APIRequestContext }>
): Promise<typeof PreparedAssessment.Type> =>
  input.request
    .get(`${operatorOrigin}/assessment/prepare`)
    .then((response) => response.json())
    .then(Schema.decodeUnknownPromise(PreparedAssessment));
