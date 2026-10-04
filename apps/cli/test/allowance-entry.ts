import { Effect, Schema } from "effect";
import { makeCanonicalFixture } from "../src/canonical/canonical.test-fixture";
import { runOperationCommand } from "../src/canonical/operations";
import { makeCanonicalClient, readOperationInput } from "../src/canonical/runtime";

/** Test-only process composition: real server responses cross the same generated client and output channels. */
const ServerResponse = Schema.Struct({
  body: Schema.String,
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  command: Schema.Literals(["quota", "transaction", "categories"]),
});
await Effect.runPromise(
  Effect.gen(function* () {
    const wire = yield* readOperationInput("-");
    const response = yield* Schema.decodeEffect(Schema.fromJsonString(ServerResponse))(wire);
    const fixture = makeCanonicalFixture(makeCanonicalClient)(response);
    const commands: Readonly<Record<typeof ServerResponse.Type.command, ReadonlyArray<string>>> = {
      quota: ["quota", "getQuota"],
      transaction: ["transactions", "getTransaction", "--input", "-"],
      categories: ["categories", "listCategories"],
    };
    const args = commands[response.command];
    const failed = yield* runOperationCommand(args, {
      ...fixture.dependencies,
      readInput: () => Effect.succeed('{"params":{"id":"30000000-0000-4000-8000-000000000001"}}'),
      stdout: (text) =>
        Effect.sync(() => {
          process.stdout.write(text);
        }),
      stderr: (text) =>
        Effect.sync(() => {
          process.stderr.write(text);
        }),
    });
    process.exitCode = failed ? 1 : 0;
  }).pipe(Effect.scoped)
);
