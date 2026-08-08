import * as Arr from "effect/Array";
import { Context, Option, Schema, SchemaAST } from "effect";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { type OperationPolicyValue, getOperationPolicy } from "./operation-policy";
import { makePartialInputSchema } from "./partial-input";

type OperationSchema = Schema.Codec<unknown, Schema.Json, never, never>;
type PartialInputSchema = Schema.Codec<unknown, unknown>;

/** One canonical operation projected for authorization, response checks, and hosted tooling. */
export type CatalogOperation = {
  readonly id: CanonicalOperationId;
  readonly description: string;
  readonly input: OperationSchema;
  readonly success: OperationSchema;
  readonly failure: OperationSchema;
  readonly policy: OperationPolicyValue;
  /** None when the generated client accepts no operation input. */
  readonly partialInput: Option.Option<PartialInputSchema>;
};

/** The assembled canonical-operation facts derived from one HttpApi definition. */
export type OperationCatalog = {
  readonly operations: ReadonlyArray<CatalogOperation>;
  readonly byId: ReadonlyMap<string, CatalogOperation>;
};

const payloadSchemas = (endpoint: HttpApiEndpoint.Top): ReadonlyArray<Schema.Top> =>
  Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas);

const unionSchema = (schemas: ReadonlyArray<Schema.Top>): Schema.Top => {
  if (!Arr.isReadonlyArrayNonEmpty(schemas)) return Schema.Never;
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas);
};

const asOperationSchema = (schema: Schema.Top): OperationSchema =>
  Schema.make<OperationSchema>(Schema.toCodecJson(schema).ast);

const canonicalInput = (endpoint: HttpApiEndpoint.Top): OperationSchema => {
  const fields: Array<SchemaAST.PropertySignature> = [];
  const add = (name: string, schema: Option.Option<Schema.Top>): void => {
    if (Option.isSome(schema)) {
      fields.push(new SchemaAST.PropertySignature(name, schema.value.ast));
    }
  };
  add("params", Option.fromUndefinedOr(endpoint.params));
  add("query", Option.fromUndefinedOr(endpoint.query));
  add("headers", Option.fromUndefinedOr(endpoint.headers));
  const payloads = payloadSchemas(endpoint);
  if (Arr.isReadonlyArrayNonEmpty(payloads)) add("payload", Option.some(unionSchema(payloads)));
  // A never-valued string record models an empty object while preserving a closed JSON shape for
  // consumers that require strict object parameters.
  const schema =
    fields.length === 0
      ? Schema.Record(Schema.String, Schema.Never)
      : Schema.make<PartialInputSchema>(new SchemaAST.Objects(fields, []));
  return asOperationSchema(schema);
};

const requestInput = (endpoint: HttpApiEndpoint.Top): Option.Option<PartialInputSchema> => {
  const fields: Array<SchemaAST.PropertySignature> = [];
  const add = (name: string, schema: Option.Option<Schema.Top>): void => {
    if (Option.isNone(schema)) return;
    fields.push(
      new SchemaAST.PropertySignature(
        name,
        Schema.optionalKey(makePartialInputSchema(schema.value)).ast
      )
    );
  };

  add("params", Option.fromUndefinedOr(endpoint.params));
  add("query", Option.fromUndefinedOr(endpoint.query));
  add("headers", Option.fromUndefinedOr(endpoint.headers));

  const payloads = payloadSchemas(endpoint);
  if (Arr.isReadonlyArrayNonEmpty(payloads)) add("payload", Option.some(unionSchema(payloads)));

  return fields.length === 0
    ? Option.none()
    : Option.some(Schema.make<PartialInputSchema>(new SchemaAST.Objects(fields, [])));
};

/**
 * Reflects canonical ids, partial target inputs, and callability policy from the
 * same assembled HttpApi used by the server and generators. Duplicate ids fail
 * here rather than letting one operation silently replace another in the map.
 */
export const makeOperationCatalog = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): OperationCatalog => {
  const operations: Array<CatalogOperation> = [];
  const byId = new Map<string, CatalogOperation>();

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, mergedAnnotations }) => {
      const defaultId = `${group.identifier}.${endpoint.identifier}`;
      const reflectedId = Context.getOrElse(mergedAnnotations, OpenApi.Identifier, () =>
        group.topLevel ? endpoint.identifier : defaultId
      );
      const id = CanonicalOperationId.make(reflectedId);
      if (reflectedId !== defaultId) {
        throw new Error(
          `Canonical operations must publish their group-qualified identifier: ${defaultId}`
        );
      }
      if (byId.has(id)) {
        throw new Error(`Duplicate canonical operation id: ${id}`);
      }
      const description = Context.getOption(mergedAnnotations, OpenApi.Description);
      if (Option.isNone(description)) {
        throw new Error(`Canonical operation is missing its agent description: ${id}`);
      }
      const operation = {
        id,
        description: description.value,
        input: canonicalInput(endpoint),
        success: asOperationSchema(unionSchema(Array.from(endpoint.success))),
        failure: asOperationSchema(unionSchema(Array.from(endpoint.error))),
        // Access policy must be an explicit choice on each canonical operation;
        // unlike descriptive OpenAPI metadata, group defaults could silently
        // authorize a newly added operation with a policy nobody reviewed.
        policy: getOperationPolicy(endpoint),
        partialInput: requestInput(endpoint),
      };
      operations.push(operation);
      byId.set(id, operation);
    },
  });

  if (operations.length === 0) {
    throw new Error("The canonical operation catalog cannot be empty");
  }

  return { operations, byId };
};

let boundCatalog = Option.none<OperationCatalog>();

/**
 * Binds response-schema derivation to the assembled API once module evaluation
 * has finished building it. A second, different assembly is a programmer defect
 * rather than a last-writer-wins global registry.
 */
export const bindOperationCatalog = (catalog: OperationCatalog): void => {
  if (Option.isSome(boundCatalog) && boundCatalog.value !== catalog) {
    throw new Error("The canonical operation catalog was already bound");
  }
  boundCatalog = Option.some(catalog);
};

/** Reads the catalog after `api.ts` has bound the assembled canonical API. */
export const getBoundOperationCatalog = (): OperationCatalog =>
  Option.getOrThrowWith(
    boundCatalog,
    () => new Error("The canonical operation catalog has not been bound")
  );
