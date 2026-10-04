import { TokenBearer } from "@fidy/server/client";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { runOperationCommand } from "../src/canonical/operations";
import { makeCanonicalClient, readOperationInput } from "../src/canonical/runtime";
import { SavedGrant, apiOrigin } from "../src/credential/contract";

/** Test-only process composition: real server responses cross the same generated client and output channels. */
const ServerResponse = Schema.Struct({
  body: Schema.String,
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  command: Schema.Literals(["quota", "transaction", "categories"]),
});
const grant = Schema.decodeSync(Schema.toCodecJson(SavedGrant))({
  origin: apiOrigin,
  pat: {
    _tag: "PAT",
    id: "01900000-0000-4000-8000-000000000001",
    shortId: "abcd1234",
    recipientLabel: "Allowance integration",
    scopes: ["read"],
    lifetimeDays: 7,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-08T00:00:00.000Z",
  },
});
const secretCharacters = 43;
const bearer = Redacted.make(TokenBearer.make(`fin_abcd1234_${"s".repeat(secretCharacters)}`));
const commands: Readonly<Record<typeof ServerResponse.Type.command, ReadonlyArray<string>>> = {
  quota: ["quota", "getQuota"],
  transaction: ["transactions", "getTransaction", "--input", "-"],
  categories: ["categories", "listCategories"],
};
await Effect.runPromise(
  Effect.gen(function* () {
    const wire = yield* readOperationInput("-");
    const response = yield* Schema.decodeEffect(Schema.fromJsonString(ServerResponse))(wire);
    const failed = yield* runOperationCommand(commands[response.command], {
      clientFactory: makeCanonicalClient,
      store: {
        load: Effect.succeedSome({ grant, bearer }),
        save: () => Effect.void,
        clear: Effect.void,
      },
      httpClient: HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(response.body, { status: response.status, headers: response.headers })
          )
        )
      ),
      readInput: () => Effect.succeed('{"params":{"id":"30000000-0000-4000-8000-000000000001"}}'),
      stdout: (text) =>
        Effect.sync(() => {
          process.stdout.write(text);
        }),
      stderr: (text) =>
        Effect.sync(() => {
          process.stderr.write(text);
        }),
      json: true,
    });
    process.exitCode = failed ? 1 : 0;
  }).pipe(Effect.scoped)
);
