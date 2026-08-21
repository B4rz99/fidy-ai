import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  Category,
  CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  UpdateKeywordRuleInput,
} from "~/core/categories/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { createdStatus } from "~/shell/_shared/http-status";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const read = operationPolicy({
  requiredCapability: "read",
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  requiredCapability: "write",
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  requiredCapability: "write",
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

/** Public Category discovery and caller-owned keyword-rule management. */
export const CategoriesGroup = HttpApiGroup.make("categories")
  .add(
    HttpApiEndpoint.get("listCategories", "/categories", {
      success: OperationResponse(Schema.Array(Category)),
    })
      .annotate(
        OpenApi.Description,
        "List the Colombian Categories in presentation order. Use the stable id, not the Spanish label or list position, when recording or correcting a Transaction."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("listKeywordRules", "/category-keyword-rules", {
      success: OperationResponse(Schema.Array(KeywordRule)),
    })
      .annotate(
        OpenApi.Description,
        "List the caller's counterparty keyword instructions. These rules categorize future capture before the model fallback and never rewrite existing Transactions."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("createKeywordRule", "/category-keyword-rules", {
      payload: CreateKeywordRuleInput,
      success: OperationResponse(KeywordRule).pipe(HttpApiSchema.status(createdStatus)),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Teach future capture that a counterparty containing this case- and accent-insensitive keyword belongs to one stable Category. More specific longer matching keywords win."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.put("updateKeywordRule", "/category-keyword-rules/:id", {
      params: Schema.Struct({ id: KeywordRuleId }),
      payload: UpdateKeywordRuleInput,
      success: OperationResponse(KeywordRule),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Replace one of the caller's keyword instructions for future capture. Existing Transaction Categories remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.delete("deleteKeywordRule", "/category-keyword-rules/:id", {
      params: Schema.Struct({ id: KeywordRuleId }),
      success: OperationResponse(KeywordRuleId),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Stop applying one of the caller's keyword instructions to future capture. Existing Transactions remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  );
