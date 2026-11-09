import { Schema } from "effect";
import { handleErasureRegistry, makeSqliteErasureRegistry } from "./runtime";

const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["get", "head", "delete"]), key: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("put"),
    key: Schema.String,
    value: Schema.String,
    options: Schema.Struct({
      onlyIf: Schema.Struct({
        etagMatches: Schema.optionalKey(Schema.String),
        etagDoesNotMatch: Schema.optionalKey(Schema.String),
      }),
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("list"),
    options: Schema.Struct({
      limit: Schema.Int,
      prefix: Schema.optionalKey(Schema.String),
      cursor: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({ action: Schema.Literals(["lose", "refuse-writes"]) }),
]);

export class RegistryFixture {
  private registry;
  private readonly state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
    this.registry = makeSqliteErasureRegistry(state.storage);
  }
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).origin !== "https://fixture.internal") {
      return handleErasureRegistry({ request, registry: this.registry });
    }
    return request
      .json()
      .then((raw: unknown) => {
        const command = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" })(raw);
        switch (command.action) {
          case "get":
            return this.registry
              .get(command.key)
              .then((row) =>
                row === null
                  ? Response.json(null)
                  : row
                      .text()
                      .then((value) => Response.json({ etag: row.etag, size: row.size, value }))
              );
          case "head":
            return this.registry.head(command.key).then((row) => Response.json(row));
          case "put":
            return this.registry
              .put(command.key, command.value, command.options)
              .then((row) => Response.json(row));
          case "delete":
            return this.registry.delete(command.key).then(() => Response.json(null));
          case "list":
            return this.registry.list(command.options).then((page) => Response.json(page));
          case "lose":
            return this.state.storage.deleteAll().then(() => {
              this.registry = makeSqliteErasureRegistry(this.state.storage);
              return Response.json(null);
            });
          case "refuse-writes":
            this.state.storage.sql.exec(
              "CREATE TRIGGER refuse_registry_update BEFORE UPDATE ON erasure_registry BEGIN SELECT RAISE(ABORT,'fixture_refusal'); END"
            );
            return this.state.storage.sync().then(() => Response.json(null));
        }
      })
      .catch(() => new Response(null, { status: 503 }));
  }
}
