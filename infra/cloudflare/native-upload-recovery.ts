import { Schema } from "effect";
import upload from "./native-fixture-upload.json" with { type: "json" };

const binding = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

const handlers = Schema.Struct({
  handlers: Schema.Array(Schema.String),
  named_handlers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        handlers: Schema.Array(Schema.String),
      })
    )
  ),
});

const version = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.String,
    annotations: Schema.Struct({
      "workers/tag": Schema.Literal("release-" + upload.sourceRun + "-1"),
      "workers/message": Schema.Literal("isolated"),
    }),
    resources: Schema.Struct({ script: handlers, bindings: Schema.Array(binding) }),
  }),
});

const receiptScript = (role: "core" | "ingress", script: typeof handlers.Type): boolean =>
  role === "ingress"
    ? script.named_handlers === undefined && script.handlers.join(",") === "fetch"
    : script.named_handlers?.some((entry) => entry.name === "UserStore") === true;

const sourceBinding = Schema.is(
  Schema.Tuple([
    Schema.Struct({
      name: Schema.Literal("RELEASE_GIT_SHA"),
      type: Schema.Literal("plain_text"),
      text: Schema.Literal(upload.revision),
    }),
  ])
);

export const requireInterruptedUpload = (versions: { core: unknown; ingress: unknown }): void => {
  for (const role of ["core", "ingress"] as const) {
    const { result } = Schema.decodeUnknownSync(version)(versions[role]);
    const { script, bindings } = result.resources;
    const revisions = bindings.filter((item) => item.name === "RELEASE_GIT_SHA");

    if (
      result.id !== upload[role === "core" ? "coreVersion" : "ingressVersion"] ||
      !sourceBinding(revisions) ||
      !receiptScript(role, script)
    ) {
      throw Error("Interrupted Worker upload identity differs");
    }
  }
};
