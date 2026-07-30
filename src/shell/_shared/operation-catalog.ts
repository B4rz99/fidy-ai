import * as Arr from "effect/Array";
import { Context, Option, Schema, SchemaAST } from "effect";
import { HttpApi, type HttpApiEndpoint, type HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { getOperationPolicy, type OperationPolicyValue } from "./operation-policy";
import { makePartialInputSchema } from "./partial-input";

type OperationInputSchema = Schema.Codec<unknown, unknown>;

/** One canonical operation as the response checkpoint needs to understand it. */
export type CatalogOperation = {
  readonly id: string;
  readonly policy: OperationPolicyValue;
  /** None when the generated client accepts no operation input. */
  readonly partialInput: Option.Option<OperationInputSchema>;
};

/** The assembled canonical-operation facts derived from one HttpApi definition. */
export type OperationCatalog = {
  readonly operations: ReadonlyArray<CatalogOperation>;
  readonly byId: ReadonlyMap<string, CatalogOperation>;
};

const requestInput = (endpoint: HttpApiEndpoint.Top): Option.Option<OperationInputSchema> => {
  const fields: Array<SchemaAST.PropertySignature> = [];
  const add = (name: string, schema: Schema.Top | undefined) => {
    if (schema === undefined) return;
    fields.push(
      new SchemaAST.PropertySignature(name, Schema.optionalKey(makePartialInputSchema(schema)).ast)
    );
  };

  add("params", endpoint.params);
  add("query", endpoint.query);
  add("headers", endpoint.headers);

  const payloads = Array.from(endpoint.payload.values()).flatMap(({ schemas }) =>
    schemas.map(makePartialInputSchema)
  );
  if (Arr.isReadonlyArrayNonEmpty(payloads)) {
    add("payload", payloads.length === 1 ? payloads[0] : Schema.Union(payloads));
  }

  return fields.length === 0
    ? Option.none()
    : Option.some(Schema.make<OperationInputSchema>(new SchemaAST.Objects(fields, [])));
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
    onEndpoint: ({ endpoint, group }) => {
      const defaultId = `${group.identifier}.${endpoint.identifier}`;
      const id = Context.getOrElse(endpoint.annotations, OpenApi.Identifier, () =>
        group.topLevel ? endpoint.identifier : defaultId
      );
      if (id !== defaultId) {
        throw new Error(
          `Canonical operations must publish their group-qualified identifier: ${defaultId}`
        );
      }
      if (byId.has(id)) {
        throw new Error(`Duplicate canonical operation id: ${id}`);
      }
      const operation = {
        id,
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
