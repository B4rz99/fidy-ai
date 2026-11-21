import { Redacted } from "effect";
import { openAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { openAiRun } from "./runtime";
import { evaluationHandler } from "./internal/adversarial-evaluation";
import { evaluationBudget } from "./internal/evaluation-budget";

export const makeHostedEvaluationHandler = (): ReturnType<typeof evaluationHandler> =>
  evaluationHandler({
    makeInference: openAiHostedInference,
    makeBudget: (environment) =>
      evaluationBudget({
        environment,
        execute: openAiRun(Redacted.make(environment.OPENAI_API_KEY)),
      }),
  });

export default makeHostedEvaluationHandler();
