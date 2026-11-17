import { isDeepStrictEqual } from "node:util";
import { Option, Schema } from "effect";

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

export type WorkerResources = Readonly<{
  migrationTag: string;
  runtime: Readonly<Record<string, unknown>>;
  bindings: Readonly<Record<string, unknown>>;
  exports: Readonly<Record<string, unknown>>;
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
  // Each side has proved its exact source revision. Preserve all other binding properties for comparison.
  return Object.fromEntries(
    bindings.map((binding) => [
      binding.name,
      binding === release ? { name: release.name, type: release.type } : binding,
    ])
  );
};

/** Read the immutable version response without exposing configuration values on failure. */
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
    migrationTag:
      typeof script_runtime.migration_tag === "string" ? script_runtime.migration_tag : "",
    runtime: script_runtime,
    exports: { defaultHandlers: script.handlers.toSorted(), namedHandlers },
  };
};

/** Conservative eligibility: only code changed, with unchanged versioned binding and DO configuration. */
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
      path.startsWith("apps/server/cloudflare/migrations/") ||
      (path.startsWith("apps/server/cloudflare/") && /workflow|queue/i.test(path))
  );
