import { makeWorkersAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { makeEvaluationHandler } from "./internal/adversarial-evaluation";

/** Private local composition: real inference, synthetic owners, no tool executor. */
export const makeHostedEvaluationHandler = (): ReturnType<typeof makeEvaluationHandler> =>
  makeEvaluationHandler(makeWorkersAiHostedInference);

// Never part of the application deployment graph.
export default makeHostedEvaluationHandler();
