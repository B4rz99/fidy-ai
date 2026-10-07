#!/usr/bin/env bun
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { FetchHttpClient, HttpClient } from "effect/http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Data, Effect, FileSystem, Layer, type PlatformError, Schema } from "effect";
import {
  type NativeHost,
  type NativeMode,
  NativeProofError,
  nativeTools,
} from "./production-native";

/** Local-only native confirmation proof. Start oauth-confirmation.test.ts's opt-in
 * FIDY_988_HOST_BRIDGE_FILE fixture first, then pass the pinned --claude/--codex binaries.
 * The bridge injects a disposable approved OAuth credential; this never proves native OAuth login. */
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class LocalProofFailure extends Data.TaggedError("LocalProofFailure")<{
  message: string;
}> {}
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const bridgeUrl = "http://127.0.0.1:19488";
const httpOk = 200;
const requestTimeout = 10_000;
const Cases = Schema.Literals([
  "claude-accept",
  "claude-cancel",
  "codex-accept",
  "codex-cancel",
  "claude-headless",
  "codex-headless",
]);
type HostCase = typeof Cases.Type;
const Reset = Schema.Struct({ budgetId: Schema.String.check(Schema.isUUID()) });
const Trace = Schema.Struct({
  method: Schema.String,
  tool: Schema.String,
  action: Schema.String,
  continuation: Schema.Boolean,
  advertisedForm: Schema.Boolean,
  declaredClient: Schema.String,
  offeredProtocol: Schema.String,
  protocolHeader: Schema.String,
  negotiatedProtocol: Schema.String,
  httpStatus: Schema.Int,
});
const Status = Schema.Struct({
  budgetId: Reset.fields.budgetId,
  remaining: Schema.Int,
  accepted: Schema.Int,
  trace: Schema.Array(Trace),
});
type Arguments = Readonly<{
  claude: string;
  codex: string;
  output: string;
  cases: ReadonlyArray<HostCase>;
}>;
type CaseResult = Readonly<{
  host: NativeHost;
  decision: NativeMode;
  formAnswered: boolean;
  remaining: number;
  acceptedAudit: number;
  trace: ReadonlyArray<typeof Trace.Type>;
  actualToolCalled: boolean;
  passed: boolean;
}>;
const requireCheck = (
  passed: boolean,
  message: string
): Effect.Effect<void, never, never> | Effect.Effect<never, LocalProofFailure, never> =>
  passed ? Effect.void : Effect.fail(new LocalProofFailure({ message }));
const bridge = <A>(
  path: string,
  codec: Schema.Codec<A>
): Effect.Effect<A, LocalProofFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(bridgeUrl + path).pipe(Effect.timeout(requestTimeout));
    yield* requireCheck(response.status === httpOk, "Local fixture bridge refused");
    return yield* Schema.decodeUnknownEffect(codec)(yield* response.json);
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(new LocalProofFailure({ message: "Local fixture bridge unavailable" }))
    )
  );
const writeJson = (
  path: string,
  value: unknown
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(path, stringify(value) + "\n", { mode: privateFileMode })
  );

const decodeArguments = Schema.decodeUnknownSync(
  Schema.Struct({
    claude: Schema.NonEmptyString,
    codex: Schema.NonEmptyString,
    output: Schema.NonEmptyString,
  })
);
const decodeCases = Schema.decodeUnknownSync(Schema.Array(Cases));
const readArguments = Effect.try({
  try: (): Arguments => {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        claude: {
          type: "string",
        },
        codex: {
          type: "string",
        },
        output: {
          type: "string",
          default: "/tmp/fidy-988-core/hosts",
        },
        cases: {
          type: "string",
          multiple: true,
        },
      },
    });
    const { claude, codex, output } = decodeArguments(parsed.values);
    const requested =
      parsed.values.cases !== undefined
        ? [...parsed.values.cases, ...parsed.positionals]
        : [...Cases.literals];
    if (parsed.values.cases === undefined && parsed.positionals.length > 0) {
      throw new Error("unexpected arguments");
    }
    if (requested.length === 0 || new Set(requested).size !== requested.length) {
      throw new Error("duplicate cases");
    }
    return {
      claude: resolve(claude),
      codex: resolve(codex),
      output: resolve(output),
      cases: decodeCases(requested),
    };
  },
  catch: () =>
    new LocalProofFailure({
      message: "Expected --claude PATH --codex PATH [--output DIR] [--cases CASE ...]",
    }),
});
const prepareCase = Effect.fn(function* (
  input: Readonly<{
    host: NativeHost;
    root: string;
    budgetId: string;
  }>
) {
  const { host, root, budgetId } = input;
  const profile = join(root, `${host}-profile`);
  const filesystem = yield* FileSystem.FileSystem;
  yield* filesystem.makeDirectory(root, { mode: privateDirectoryMode });
  yield* filesystem.makeDirectory(profile, { mode: privateDirectoryMode });
  yield* filesystem.chmod(root, privateDirectoryMode);
  yield* writeJson(join(root, `${host}-budget-private.json`), {
    id: budgetId,
  });
  if (host === "claude") {
    yield* writeJson(join(profile, ".claude.json"), {
      hasCompletedOnboarding: true,
      theme: "dark",
      mcpServers: {
        fidy: {
          type: "http",
          url: `${bridgeUrl}/mcp`,
        },
      },
      projects: {
        [root]: {
          hasTrustDialogAccepted: true,
          allowedTools: ["mcp__fidy__*"],
        },
      },
    });
  }
});
const decisionFor = (name: HostCase): NativeMode => {
  if (name.endsWith("-headless")) return "headless";
  if (name.endsWith("-cancel")) return "cancel";
  return "accept";
};
const runCase = Effect.fn(function* (args: Arguments, name: HostCase) {
  const host: NativeHost = name.startsWith("claude-") ? "claude" : "codex";
  const decision = decisionFor(name);
  const root = join(args.output, name);
  const reset = yield* bridge("/reset", Reset);
  yield* prepareCase({
    host,
    root,
    budgetId: reset.budgetId,
  });
  const native = yield* nativeTools(host, args[host], root, decision, "local-native-confirmation", {
    mcpUrl: `${bridgeUrl}/mcp`,
  });
  const observed = yield* bridge("/status", Status);
  const accepted = decision === "accept";
  const actualToolCalled = observed.trace.some(
    (event) => event.method === "tools/call" && event.tool === "budgets.deleteBudget"
  );
  const passed = [
    native.passed,
    actualToolCalled,
    observed.budgetId === reset.budgetId,
    observed.remaining === (accepted ? 0 : 1),
    observed.accepted === (accepted ? 1 : 0),
  ].every(Boolean);
  const result: CaseResult = {
    host,
    decision,
    formAnswered: native.nativeFormAnswered,
    remaining: observed.remaining,
    acceptedAudit: observed.accepted,
    trace: observed.trace,
    actualToolCalled,
    passed,
  };
  yield* writeJson(join(root, "result.json"), result);
  yield* Effect.sync(() => {
    process.stdout.write(stringify(result) + "\n");
  });
  yield* requireCheck(passed, `Local native ${name} proof failed`);
  return result;
});
const cleanupCase = (
  root: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.forEach(
      ["claude", "codex"],
      (host) =>
        Effect.forEach(
          [
            host + "-profile",
            host + "-budget-private.json",
            host + "-catalog-private.json",
            host + "-outputs-private.json",
            ...["accept", "cancel", "headless"].map(
              (mode) => host + "-" + mode + "-outputs-private.json"
            ),
          ],
          (name) => fs.remove(join(root, name), { force: true, recursive: true }),
          { discard: true }
        ),
      { discard: true }
    )
  );

const execute = Effect.gen(function* () {
  const args = yield* readArguments;
  yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeDirectory(args.output, { recursive: true, mode: privateDirectoryMode })
  );
  yield* Effect.addFinalizer(() =>
    bridge(
      "/finish",
      Schema.Struct({
        finished: Schema.Literal(true),
      })
    ).pipe(Effect.orDie)
  );
  const results: CaseResult[] = [];
  for (const name of args.cases) {
    const result = yield* runCase(args, name).pipe(
      Effect.ensuring(cleanupCase(join(args.output, name)).pipe(Effect.orDie))
    );
    results.push(result);
  }
  yield* writeJson(join(args.output, "evidence.json"), {
    trustBoundary: "OAuth-authorized client acceptance, not independently verified human presence",
    actualSeam:
      "Public ingress → Core → User coordinator → canonical mutation and Audit in native D1",
    fixture:
      "Disposable approved OAuth credential injected by local bridge; canned model; pinned native CLIs and PTYs. No Production or inference.",
    results,
  });
});
if (import.meta.main) {
  Effect.runPromise(
    Effect.scoped(execute).pipe(
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunCrypto.layer, FetchHttpClient.layer))
    )
  ).catch((error: unknown) => {
    if (error instanceof LocalProofFailure) process.stderr.write(error.message + "\n");
    if (error instanceof NativeProofError) {
      process.stderr.write(`Native ${error.host} failed during ${error.phase}: ${error.reason}\n`);
    }
    process.stderr.write(
      "Local native confirmation proof failed; inspect metadata-only result files.\n"
    );
    process.exitCode = 1;
  });
}
