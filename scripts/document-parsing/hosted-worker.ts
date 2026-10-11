import { Config, Crypto, Data, Effect, FileSystem, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { requestHostedProof } from "./local-workerd-http";

const proofRequestTimeout = 5000;
const hiddenProofStatus = 404;
const successfulStatusStart = 200;
const successfulStatusEnd = 300;
class HostedProofCommandFailed extends Data.TaggedError("HostedProofCommandFailed")<{
  readonly operation: string;
  readonly exitCode: number;
  readonly codes: ReadonlyArray<string>;
}> {}
export type HostedWorkerProof = Readonly<{ origin: string; token: string }>;

// Wrangler delete also lists legacy Sites KV namespaces, which this proof never creates.
const deleteProofWorker = Effect.fn(function* (name: string) {
  if (!/^xlsx-proof-[a-f0-9]{8}$/u.test(name)) throw new Error("Invalid proof Worker name");
  const account = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(client).execute(
    HttpClientRequest.make("DELETE")(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${name}`
    ).pipe(HttpClientRequest.bearerToken(token))
  );
  if (response.status >= successfulStatusStart && response.status < successfulStatusEnd) return;
  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ errors: Schema.Array(Schema.Struct({ code: Schema.Finite })) })
  )(yield* response.json);
  const codes = body.errors.map((error) => String(error.code));
  if (codes.includes("10090") || codes.includes("10007")) return;
  return yield* new HostedProofCommandFailed({ operation: "delete", exitCode: 1, codes });
});

const runWrangler = Effect.fn(function* (directory: string, args: ReadonlyArray<string>) {
  const command = Bun.spawn(
    ["node_modules/.bin/wrangler", ...args, "--config", `${directory}/wrangler.json`],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [output, diagnostics] = yield* Effect.tryPromise(() =>
    Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text()])
  );
  const exitCode = yield* Effect.tryPromise(() => command.exited);
  if (exitCode !== 0) {
    const codes = Array.from(
      `${output}\n${diagnostics}`.matchAll(/(?:code[:\s]*|"code"\s*:)\s*(\d+)/gu),
      (match) => match[1] ?? "unknown"
    );
    return yield* new HostedProofCommandFailed({
      operation: args[0] ?? "unknown",
      exitCode,
      codes,
    });
  }
  return output;
});

/** Owns one unique synthetic proof Worker and optional namespace retirement through cleanup. */
export const hostedWorkerProof = Effect.fn(function* (
  input: Readonly<{
    directory: string;
    name: string;
    retirement: Option.Option<Readonly<{ config: string; worker: string }>>;
  }>
) {
  const { directory, retirement } = input;
  const token = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const secrets = `${directory}/proof-secrets.json`;
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ XLSX_PROOF_KEY: Schema.String }))
  )({ XLSX_PROOF_KEY: token });
  yield* fs.writeFileString(secrets, encoded, { mode: 0o600 });
  yield* Effect.addFinalizer(() => deleteProofWorker(input.name).pipe(Effect.scoped, Effect.orDie));
  const output = yield* runWrangler(directory, ["deploy", "--secrets-file", secrets]);
  if (Option.isSome(retirement)) {
    const retired = retirement.value;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${directory}/worker.js`, retired.worker);
        yield* fs.writeFileString(`${directory}/wrangler.json`, retired.config);
        yield* runWrangler(directory, ["deploy"]);
      }).pipe(Effect.orDie)
    );
  }
  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/iu.exec(output)?.[0];
  if (origin === undefined) throw new Error("Isolated parser Worker did not expose its HTTPS URL");
  const unauthorized = yield* Effect.tryPromise(() =>
    requestHostedProof({
      origin,
      port: 0,
      path: "/statement-work",
      method: "POST",
      body: "Date,Amount\n2026-01-01,1",
      headers: {},
      signal: AbortSignal.timeout(proofRequestTimeout),
    })
  );
  if (unauthorized.status !== hiddenProofStatus) {
    throw new Error("Isolated parser Worker did not require its access key");
  }
  return { origin, token };
});
