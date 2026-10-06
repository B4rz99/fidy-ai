import { Schema, SchemaAST } from "effect";
import { oauthResource } from "~/shell/oauth-agents/contract";
import { UserId } from "~/core/identity/contract";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { OAuthClientId, OAuthConnectionId, OAuthCredentialId } from "~/core/oauth-agents/contract";
import type { CatalogOperation, OperationCatalog } from "~/shell/canonical-catalog/contract";

const digestLength = 32;
/** Standard native-client decision carried privately, separate from canonical arguments. */
export const OAuthConfirmationAttempt = Schema.Union([
  Schema.TaggedStruct("Review", {}),
  Schema.TaggedStruct("Decision", {
    reference: Schema.String.check(Schema.isUUID()),
    response: Schema.Json,
  }),
]);
export type OAuthConfirmationAttempt = typeof OAuthConfirmationAttempt.Type;
/** Private admission facts, not a reusable authorization grant; Core rechecks them at execution. */
export const OAuthCanonicalAdmission = Schema.Struct({
  userId: UserId,
  clientId: OAuthClientId,
  connectionId: OAuthConnectionId,
  credentialId: OAuthCredentialId,
  resource: Schema.Literal(oauthResource),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(digestLength, digestLength)
  ),
  deadlineMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: CanonicalOperationId,
  input: Schema.Json,
  confirmation: Schema.optionalKey(OAuthConfirmationAttempt),
});
export type OAuthCanonicalAdmission = typeof OAuthCanonicalAdmission.Type;

type ProjectAst = (ast: SchemaAST.AST) => SchemaAST.AST;
const projectChildren = (ast: SchemaAST.AST, project: ProjectAst): SchemaAST.AST => {
  if (SchemaAST.isObjects(ast)) {
    return new SchemaAST.Objects(
      ast.propertySignatures.map(
        (field) => new SchemaAST.PropertySignature(field.name, project(field.type))
      ),
      ast.indexSignatures.map(
        (field) => new SchemaAST.IndexSignature(field.parameter, project(field.type))
      ),
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
      ast.encodingChecks
    );
  }
  if (SchemaAST.isArrays(ast)) {
    return new SchemaAST.Arrays(
      ast.isMutable,
      ast.elements.map(project),
      ast.rest.map(project),
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context,
      ast.encodingChecks
    );
  }
  if (SchemaAST.isSuspend(ast)) {
    return new SchemaAST.Suspend(
      () => project(ast.thunk()),
      ast.annotations,
      ast.checks,
      ast.encoding,
      ast.context
    );
  }
  return ast;
};
type ScopeProjection = Readonly<{ catalog: OperationCatalog; allowedIds: ReadonlySet<string> }>;
const inaccessibleTarget = (ast: SchemaAST.AST, input: ScopeProjection): boolean => {
  if (!SchemaAST.isObjects(ast)) return false;
  return ast.propertySignatures.some(
    ({ name, type }) =>
      (name === "tool" || name === "operation") &&
      SchemaAST.isLiteral(type) &&
      typeof type.literal === "string" &&
      input.catalog.byId.has(type.literal) &&
      !input.allowedIds.has(type.literal)
  );
};

/** Schema-private projection removes inaccessible canonical target alternatives before JSON Schema export, including their hinted arguments at any envelope depth. */
export const projectMcpSchemas = (
  input: ScopeProjection & Readonly<{ operation: CatalogOperation }>
): Readonly<{ input: Schema.Codec<Schema.Json>; output: Schema.Codec<Schema.Json> }> => {
  const memo = new Map<SchemaAST.AST, SchemaAST.AST>();
  const project: ProjectAst = (ast) => {
    const cached = memo.get(ast);
    if (cached !== undefined) return cached;
    let value: SchemaAST.AST;
    if (inaccessibleTarget(ast, input)) value = SchemaAST.never;
    else if (SchemaAST.isUnion(ast)) {
      value = new SchemaAST.Union(
        ast.types.filter((member) => !inaccessibleTarget(member, input)).map(project),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks
      );
    } else value = projectChildren(ast, project);
    memo.set(ast, value);
    return value;
  };
  return {
    input: Schema.make<Schema.Codec<Schema.Json>>(
      project(SchemaAST.toEncoded(input.operation.input.ast))
    ),
    output: Schema.make<Schema.Codec<Schema.Json>>(
      project(
        SchemaAST.toEncoded(Schema.Union([input.operation.success, input.operation.failure]).ast)
      )
    ),
  };
};
