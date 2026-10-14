import { makeWorkersAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { makeEvaluationHandler } from "./internal/adversarial-evaluation";

export const makeHostedEvaluationHandler = (): ReturnType<typeof makeEvaluationHandler> =>
  makeEvaluationHandler(makeWorkersAiHostedInference);

export default makeHostedEvaluationHandler();
