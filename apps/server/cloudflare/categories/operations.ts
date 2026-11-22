import {
  newKeywordRuleId as allocateRuleId,
  localKeywordRules as listRules,
  prepareLocalKeywordRule as prepareRule,
} from "./internal/sqlite-keyword";
import {
  categorizeLocalCapture as nativeCategory,
  resolveLocalCategory as resolveCategory,
  retainLocalCategory as retainCategory,
} from "./internal/native-categorization";

import {
  keywordRuleIdFromPath as decodeRuleId,
  keywordRuleUnknownId as unknownRuleId,
} from "./internal/canonical-keyword-rules";

export const keywordRuleIdFromPath: typeof decodeRuleId = (input) => decodeRuleId(input);

export const keywordRuleUnknownId = (): Response => unknownRuleId();

export const categorizeLocalCapture: typeof nativeCategory = (input) => nativeCategory(input);

export const localKeywordRules: typeof listRules = (user) => listRules(user);

export const newKeywordRuleId: typeof allocateRuleId = () => allocateRuleId();

export const prepareLocalKeywordRule: typeof prepareRule = (command, user, current) =>
  prepareRule(command, user, current);

export const resolveLocalCategory: typeof resolveCategory = (input) => resolveCategory(input);

export const retainLocalCategory: typeof retainCategory = (reference) => retainCategory(reference);
