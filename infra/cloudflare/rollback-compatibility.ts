import { isDeepStrictEqual } from "node:util";
import { Option, Predicate, Schema } from "effect";

const describedBinding = Schema.StructWithRest(
  Schema.Struct({ name: Schema.NonEmptyString, type: Schema.NonEmptyString }),
  [Schema.Record(Schema.String, Schema.Json)]
);

const providerVersion = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.String,
    resources: Schema.Struct({
      bindings: Schema.Array(describedBinding),
      script: Schema.Struct({
        handlers: Schema.Array(Schema.String),
        named_handlers: Schema.Array(
          Schema.Struct({ name: Schema.NonEmptyString, handlers: Schema.Array(Schema.String) })
        ),
      }),
      script_runtime: Schema.StructWithRest(
        Schema.Struct({ compatibility_date: Schema.NonEmptyString }),
        [Schema.Record(Schema.String, Schema.Json)]
      ),
    }),
  }),
});

export type WorkerBindings = Readonly<Record<string, Schema.Json>>;

export type WorkerResources = Readonly<{
  migrationTag: string;
  runtime: Readonly<Record<string, Schema.Json>>;
  bindings: WorkerBindings;
  exports: Readonly<Record<string, Schema.Json>>;
}>;

const namespaceIdentity = Schema.is(
  Schema.Struct({
    class_name: Schema.NonEmptyString,
    namespace_id: Schema.NonEmptyString,
  })
);

const versionBindings = (
  bindings: ReadonlyArray<typeof describedBinding.Type>,
  revision: string
): WorkerResources["bindings"] => {
  const release = bindings.find((binding) => binding.name === "RELEASE_GIT_SHA");

  if (release?.type !== "plain_text" || release.text !== revision) {
    throw new Error("Worker release binding does not match the attested revision");
  }

  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length) {
    throw new Error("Duplicate Worker binding identity");
  }

  if (
    bindings.some(
      (binding) => binding.type === "durable_object_namespace" && !namespaceIdentity(binding)
    )
  ) {
    throw new Error("Durable Object namespace identity unavailable");
  }

  return Object.fromEntries(
    bindings.map((binding) => [
      binding.name,
      binding === release ? { name: release.name, type: release.type } : binding,
    ])
  );
};

export const verifiedVersionResources = ({
  raw,
  versionId,
  revision,
}: Readonly<{ raw: unknown; versionId: string; revision: string }>): WorkerResources => {
  const decoded = Schema.decodeUnknownOption(providerVersion)(raw);

  if (Option.isNone(decoded) || decoded.value.result.id !== versionId) {
    throw new Error("Worker version identity unavailable");
  }

  const { bindings, script, script_runtime } = decoded.value.result.resources;

  const namedHandlers = Object.fromEntries(
    script.named_handlers.map(({ name, handlers }) => [name, handlers.toSorted()])
  );

  if (Object.keys(namedHandlers).length !== script.named_handlers.length) {
    throw new Error("Worker export identity unavailable");
  }

  return {
    bindings: versionBindings(bindings, revision),
    migrationTag: Predicate.isString(script_runtime.migration_tag)
      ? script_runtime.migration_tag
      : "",
    runtime: script_runtime,
    exports: { defaultHandlers: script.handlers.toSorted(), namedHandlers },
  };
};

export const rollbackCompatible = (
  input: Readonly<{
    stable: WorkerResources;
    candidate: WorkerResources;
    changedPaths: ReadonlyArray<string>;
    workflowPaths: ReadonlyArray<string>;
  }>
): boolean =>
  input.stable.migrationTag === input.candidate.migrationTag &&
  isDeepStrictEqual(input.stable.bindings, input.candidate.bindings) &&
  isDeepStrictEqual(input.stable.exports, input.candidate.exports) &&
  isDeepStrictEqual(input.stable.runtime, input.candidate.runtime) &&
  !input.changedPaths.some(
    (path) =>
      input.workflowPaths.includes(path) ||
      path === "infra/cloudflare/alchemy.run.ts" ||
      path === "infra/cloudflare/alchemy.storage.ts" ||
      path === "infra/cloudflare/storage-installation.ts" ||
      /^(?:apps\/server\/cloudflare\/(?:directory\/schema|runtime\/sqlite|user-store\/internal\/[^/]*schema)|infra\/cloudflare\/native-(?:application|storage|graph))/.test(
        path
      ) ||
      [
        "user-store/operations.ts",
        "subscription/pricing/operations.ts",
        "maintenance/operations.ts",
        "erasure-store/operations.ts",
      ].some((owner) => path === "apps/server/cloudflare/" + owner) ||
      (path.startsWith("apps/server/cloudflare/") && /workflow|queue/i.test(path))
  );
