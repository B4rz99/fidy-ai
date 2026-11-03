import { Redacted } from "effect";
import { makeOpenAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { makeOpenAiRun } from "./runtime";
import { makeEvaluationHandler } from "./internal/adversarial-evaluation";
import { makeEvaluationBudget } from "./internal/evaluation-budget";

export const makeHostedEvaluationHandler = (): ReturnType<typeof makeEvaluationHandler> =>
  makeEvaluationHandler({
    makeInference: makeOpenAiHostedInference,
    makeBudget: (environment) =>
      makeEvaluationBudget({
        environment,
        execute: makeOpenAiRun(Redacted.make(environment.OPENAI_API_KEY)),
      }),
  });

export default makeHostedEvaluationHandler();
