import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  Category,
  CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  UpdateKeywordRuleInput,
} from "~/core/categories/model";
import {
  NotFound,
  OperationResponse,
  Unavailable,
  ValidationFailed,
  createdStatus,
} from "~/shell/public-http/contract";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { keywordRulesPath, listCategoriesPath, retainedKeywordRulePath } from "./path";

export const ListCategoriesResponse = OperationResponse(Schema.Array(Category));

/** The caller's own rules, in stable creation order. */
export const ListKeywordRulesResponse = OperationResponse(Schema.Array(KeywordRule));

/** One created or replaced rule, or the id of a removed one. */
export const KeywordRuleResponse = OperationResponse(KeywordRule);
export const RemovedKeywordRuleResponse = OperationResponse(KeywordRuleId);

const read = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

/** Public Category discovery and caller-owned keyword-rule management. */
export const CategoriesGroup = HttpApiGroup.make("categories")
  .add(
    HttpApiEndpoint.get("listCategories", listCategoriesPath, {
      success: ListCategoriesResponse,
      error: Unavailable,
    })
      .annotate(
        OpenApi.Description,
        "List the Colombian Categories in presentation order. Use the stable id, not the Spanish label or list position, when recording or correcting a Transaction."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("listKeywordRules", keywordRulesPath, {
      success: ListKeywordRulesResponse,
    })
      .annotate(
        OpenApi.Description,
        "List the caller's counterparty keyword instructions. These rules categorize future capture before the model fallback and never rewrite existing Transactions."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("createKeywordRule", keywordRulesPath, {
      payload: CreateKeywordRuleInput,
      success: KeywordRuleResponse.pipe(HttpApiSchema.status(createdStatus)),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Teach future capture that a counterparty containing this case- and accent-insensitive keyword belongs to one stable Category. More specific longer matching keywords win."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.put("updateKeywordRule", retainedKeywordRulePath, {
      params: Schema.Struct({ id: KeywordRuleId }),
      payload: UpdateKeywordRuleInput,
      success: KeywordRuleResponse,
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Replace one of the caller's keyword instructions for future capture. Existing Transaction Categories remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.delete("deleteKeywordRule", retainedKeywordRulePath, {
      params: Schema.Struct({ id: KeywordRuleId }),
      success: RemovedKeywordRuleResponse,
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Stop applying one of the caller's keyword instructions to future capture. Existing Transactions remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  );
