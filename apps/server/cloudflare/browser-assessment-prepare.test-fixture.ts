import { DateTime, Effect, Schema } from "effect";
import {
  DashboardAssessmentConfiguration,
  dashboardAssessmentIdentities,
} from "./browser-acceptance/contract";
import { browserAssessmentConfiguration } from "./browser-acceptance/operations";

/** Prepare an isolated navigation workspace before measured work; ordinary regressions use small. */
export const prepareDashboardAssessment = (
  input: Readonly<{ db: D1Database; nativeAvailable: boolean }>
): Promise<
  Readonly<{ configuration: typeof DashboardAssessmentConfiguration.Encoded; layoutDigest: string }>
> => {
  const { db } = input;
  const configuration = browserAssessmentConfiguration();
  if (configuration.backend === "audited-native-qualified") {
    return Promise.reject(
      new Error("The native qualified backend requires completed provider qualification")
    );
  }
  if (configuration.backend === "audited-native-guarded" && !input.nativeAvailable) {
    return Promise.reject(
      new Error("The authoritative native Dashboard fixture binding is unavailable")
    );
  }
  return import("./browser-assessment.test-fixture").then(({ seedAssessment }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* seedAssessment({
          db,
          dataset: configuration.dataset,
          now: DateTime.toEpochMillis(configuration.epoch),
          users: dashboardAssessmentIdentities
            .slice(0, configuration.users)
            .map((identity) => identity.userId),
          history: configuration.history,
          layout: configuration.layout,
        });
        const first = dashboardAssessmentIdentities[0];
        const document = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT document_json FROM user_documents WHERE user_id=? AND kind='dashboard'"
            )
            .bind(first.userId)
            .first("document_json")
        );
        const encoded = yield* Schema.decodeUnknownEffect(Schema.String)(document);
        const prepared = yield* Schema.encodeEffect(DashboardAssessmentConfiguration)(
          configuration
        );
        return {
          configuration: prepared,
          layoutDigest: new Bun.CryptoHasher("sha256").update(encoded).digest("hex"),
        };
      })
    )
  );
};
