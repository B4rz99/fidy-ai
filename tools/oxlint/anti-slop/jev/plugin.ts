import { createJevPlugin } from "../../oxlint-plugin-jev/dist/index.mjs";

import {
  effectJevOptions,
  effectJevPluginName,
  effectSourceJevRules,
  effectTestJevRules,
} from "./effect-rules.ts";

/**
 * One oxlint rule per Effect question, `anti-slop-effect-jev/<id>`, so each question's severity
 * lives in the oxlint config. All enabled rules share one request per file. Source rules are
 * "warn": Jev is model-judged and can produce false positives, so its findings must not fail the
 * pipeline. Test files turn the source rules "off", where only `test-cannot-fail` runs. `ci: "skip"`
 * keeps a missing key or a failed refinement advisory in CI for the same reason.
 */
export default createJevPlugin({
  ...effectJevOptions,
  name: effectJevPluginName,
  ci: "skip",
  rules: [...effectSourceJevRules, ...effectTestJevRules],
});
