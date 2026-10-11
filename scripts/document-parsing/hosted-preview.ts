import { Crypto, Effect, FileSystem, Schema } from "effect";
import { requestHostedProof } from "./local-workerd-http";

const previewName = "parser-performance";
const proofRequestTimeout = 5000;
const hiddenProofStatus = 404;
const previewOutput = Schema.fromJsonString(
  Schema.Struct({ deployment: Schema.Struct({ urls: Schema.Array(Schema.String) }) })
);
export type HostedPreview = Readonly<{ origin: string; token: string }>;

const runWrangler = Effect.fn(function* (directory: string, args: ReadonlyArray<string>) {
  const command = Bun.spawn(
    ["node_modules/.bin/wrangler", ...args, "--config", `${directory}/wrangler.json`],
    { stdout: "pipe", stderr: "inherit" }
  );
  const output = yield* Effect.tryPromise(() => new Response(command.stdout).text());
  const exitCode = yield* Effect.tryPromise(() => command.exited);
  if (exitCode !== 0) throw new Error(`Isolated parser preview command failed (${exitCode})`);
  return output;
});

/** Owns one unique, binding-free Preview and its empty parent through cleanup. */
export const hostedPreview = Effect.fn(function* (directory: string) {
  const token = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const secrets = `${directory}/proof-secrets.json`;
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ XLSX_PROOF_KEY: Schema.String }))
  )({ XLSX_PROOF_KEY: token });
  yield* fs.writeFileString(secrets, encoded, { mode: 0o600 });
  yield* Effect.addFinalizer(() =>
    runWrangler(directory, ["delete", "--force"]).pipe(Effect.asVoid, Effect.orDie)
  );
  const output = yield* runWrangler(directory, [
    "preview",
    "--name",
    previewName,
    "--ignore-base-config",
    "--json",
    "--secrets-file",
    secrets,
  ]);
  yield* Effect.addFinalizer(() =>
    runWrangler(directory, [
      "preview",
      "delete",
      "--name",
      previewName,
      "--skip-confirmation",
    ]).pipe(Effect.asVoid, Effect.orDie)
  );
  const decoded = yield* Schema.decodeEffect(previewOutput)(output);
  const origin = decoded.deployment.urls[0];
  if (origin === undefined || !origin.startsWith("https://")) {
    throw new Error("Isolated parser Preview did not expose an HTTPS deployment URL");
  }
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
    throw new Error("Isolated parser Preview did not require its access key");
  }
  return { origin, token };
});
