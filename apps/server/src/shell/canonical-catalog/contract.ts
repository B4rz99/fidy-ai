import * as Arr from "effect/Array";
import { Context, Option, Schema, SchemaAST } from "effect";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup, OpenApi } from "effect/http-api";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import {
  AtomicBatchEligible,
  type OperationPolicyValue,
  getOperationPolicy,
} from "~/shell/canonical-policy/contract";
import { makePartialInputSchema } from "~/shell/partial-input/contract";

type OperationSchema = Schema.Codec<unknown, Schema.Json, never, never>;

type PartialInputSchema = Schema.Codec<unknown, unknown>;

export type CatalogOperation = {
  readonly id: CanonicalOperationId;
  readonly description: string;
  readonly method: HttpApiEndpoint.Top["method"];
  readonly route: string;
  readonly input: OperationSchema;
  readonly httpInput: OperationSchema;
  readonly httpFields: ReadonlyArray<"params" | "query" | "headers" | "payload">;
  readonly success: OperationSchema;
  readonly failure: OperationSchema;
  readonly policy: OperationPolicyValue;
  readonly atomicBatchEligible: boolean;
  readonly partialInput: Option.Option<PartialInputSchema>;
};

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

const canonicalInput = (endpoint: HttpApiEndpoint.Top, http = false): OperationSchema => {
  const fields: Array<SchemaAST.PropertySignature> = [];

  const add = (name: string, schema: Option.Option<Schema.Top>): void => {
    if (Option.isSome(schema)) {
      fields.push(
        new SchemaAST.PropertySignature(
          name,
          http && name !== "payload" ? Schema.toCodecStringTree(schema.value).ast : schema.value.ast
        )
      );
    }
  };

  add("params", Option.fromUndefinedOr(endpoint.params));
  add("query", Option.fromUndefinedOr(endpoint.query));
  add("headers", Option.fromUndefinedOr(endpoint.headers));
  const payloads = payloadSchemas(endpoint);

  if (Arr.isReadonlyArrayNonEmpty(payloads)) add("payload", Option.some(unionSchema(payloads)));

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

type HttpField = CatalogOperation["httpFields"][number];

const httpFieldOrder: ReadonlyArray<HttpField> = ["params", "query", "headers", "payload"];

const httpFields = (endpoint: HttpApiEndpoint.Top): CatalogOperation["httpFields"] => {
  const present: Readonly<Record<HttpField, boolean>> = {
    params: endpoint.params !== undefined,
    query: endpoint.query !== undefined,
    headers: endpoint.headers !== undefined,
    payload: payloadSchemas(endpoint).length > 0,
  };

  return httpFieldOrder.filter((field) => present[field]);
};

export const makeOperationCatalog = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): OperationCatalog => {
  const operations: Array<CatalogOperation> = [];
  const byId = new Map<string, CatalogOperation>();

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, mergedAnnotations, errors }) => {
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
        method: endpoint.method,
        route: endpoint.path,
        input: Schema.suspend(() => canonicalInput(endpoint)),
        httpInput: Schema.suspend(() => canonicalInput(endpoint, true)),
        httpFields: httpFields(endpoint),
        success: Schema.suspend(() => asOperationSchema(unionSchema(Array.from(endpoint.success)))),
        failure: Schema.suspend(() =>
          asOperationSchema(unionSchema([...errors.values()].flatMap((schemas) => [...schemas])))
        ),
        policy: getOperationPolicy(endpoint),
        atomicBatchEligible: Context.get(mergedAnnotations, AtomicBatchEligible),
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

export const bindOperationCatalog = (catalog: OperationCatalog): void => {
  if (Option.isSome(boundCatalog) && boundCatalog.value !== catalog) {
    throw new Error("The canonical operation catalog was already bound");
  }

  boundCatalog = Option.some(catalog);
};

export const getBoundOperationCatalog = (): OperationCatalog =>
  Option.getOrThrowWith(
    boundCatalog,
    () => new Error("The canonical operation catalog has not been bound")
  );
