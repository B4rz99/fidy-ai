// Native CLI managed-path ownership uses the host operating system path format.
import { join, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import {
  Cause,
  Clock,
  Config,
  Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Option,
  type PlatformError,
  Predicate,
  Redacted,
  Result,
  Schema,
  SchemaAST,
  Stream,
} from "effect";

import { budgetCategories } from "./production-fixture";
import { operationCatalog } from "../../apps/server/src/shell/api";

export type NativeHost = "claude" | "codex";
type LoginEffect = Effect.Effect<
  {
    host: NativeHost;
    passed: boolean;
  },
  PlatformError.PlatformError | NativeBoundaryFailure | Cause.TimeoutError,
  FileSystem.FileSystem
>;
type ToolPlanInput = Readonly<{
  callIds: readonly [string, string];
  occurredAt: string;
  host: NativeHost;
  mode: NativeMode;
  namespace: string;
  budgetId: string;
}>;
type AnthropicEventsInput = Readonly<{
  model: string;
  tool: Option.Option<string>;
  args: Schema.Json;
  step: number;
}>;
export type NativeMode = "journey" | "cancel" | "accept" | "repeat" | "refresh" | "headless";
export type NativeOptions = Readonly<{
  mcpUrl: string;
}>;
export class NativeProofError extends Data.TaggedError("NativeProofError")<{
  reason: string;
  host: NativeHost;
  phase: string;
  diagnostics: Option.Option<NativeDiagnostics>;
}> {}
export type NativeDiagnostics = Readonly<{
  requested: number;
  received: number;
  invoked: number;
  requests: number;
  resultsValid: boolean;
  formValid: boolean;
  failedTool: string;
  nextTool: string;
  errorCode: string;
  modelFailure: string;
  startup: NativeStartup;
  catalogSize: number;
  mainModelRequests: number;
  countTokenRequests: number;
  probeRequests: number;
  toolNames: ReadonlyArray<string>;
}>;
type NativeStartup = {
  apiKeyPrompt: boolean;
  mcpApprovalPrompt: boolean;
  trustPrompt: boolean;
  onboardingPrompt: boolean;
  themePrompt: boolean;
  apiKeyAnswered: boolean;
  mcpApprovalAnswered: boolean;
  processExited: boolean;
  deadlineReached: boolean;
  exitCode: number;
  exitSignal: string;
  terminalBytes: number;
  failureClasses: ReadonlyArray<string>;
};
export type NativeSummary = Readonly<{
  host: NativeHost;
  mode: NativeMode;
  expected: number;
  received: number;
  nativeFormAnswered: boolean;
  passed: boolean;
}>;
export type NativeCredential = Readonly<{
  accessToken: Redacted.Redacted<string>;
  refreshToken: Redacted.Redacted<string>;
  clientId: string;
  expiresAt: number;
}>;
const privateFileMode = 0o600;
const privateDirectoryMode = 0o700;
const commandTimeout = 30_000;
const outputLimit = 1_048_576;
const killDelay = 2000;
const loginTimeout = 300_000;
const callbackLimit = 16_384;
const toolsTimeout = 120_000;
const terminalLimit = 4_194_304;
const maximumResultDepth = 5;
const warmDelay = 15_000;
const formDelay = 600;
const keyDelay = 300;
const claudeRepeat = 20;
const codexRepeat = 10;
const transactionAmounts = ["15000", "16000"] as const;
const terminalEscape = "\x1b";
const hashLength = 8;
const pinnedVersions = {
  claude: "2.1.289",
  codex: "0.160.0",
} as const;
const productionUrl = "https://api.fidyapp.com/mcp";
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const ModelJsonObject = Schema.Record(Schema.String, Schema.Json);
const ModelJsonArray = Schema.Array(Schema.Json);
const HostModelRequest = Schema.Struct({
  tools: Schema.optionalKey(ModelJsonArray),
  input: Schema.optionalKey(ModelJsonArray),
  messages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.optionalKey(Schema.Union([Schema.String, ModelJsonArray])),
      })
    )
  ),
});
const ClaudeToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.NonEmptyString,
  content: Schema.Union([Schema.String, ModelJsonArray]),
  is_error: Schema.optionalKey(Schema.Boolean),
});
const CodexToolResult = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.NonEmptyString,
  output: Schema.String,
});
const TextResult = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const DaemonMetadata = Schema.Struct({
  managedCodexPath: Schema.String,
  appServerVersion: Schema.String,
});
const object = (
  value: Schema.Json
): {
  readonly [key: string]: Schema.Json;
} => (Schema.is(ModelJsonObject)(value) ? value : {});
const array = (value: Schema.Json): ReadonlyArray<Schema.Json> =>
  Schema.is(ModelJsonArray)(value) ? value : [];
const text = (value: Schema.Json): string => (Predicate.isString(value) ? value : "");
const profilePath = (host: NativeHost, root: string): string =>
  join(resolve(root), `${host}-profile`);
const privateWrite = (
  path: string,
  value: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path, value, {
        mode: privateFileMode,
      });
      yield* fs.chmod(path, privateFileMode);
    })
  );
const environment = (
  host: NativeHost,
  root: string
): {
  [key: string]: string;
} => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        !/KEY|TOKEN|SECRET|CREDENTIAL|AUTH|CLAUDE|ANTHROPIC|CODEX/u.test(name)
    )
  );
  return {
    ...env,
    TERM: "xterm-256color",
    DISABLE_TELEMETRY: "1",
    DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NO_PROXY: "127.0.0.1,localhost",
    ...(host === "claude"
      ? {
          CLAUDE_CONFIG_DIR: profilePath(host, root),
        }
      : {
          CODEX_HOME: profilePath(host, root),
        }),
  };
};
type CommandInput = Readonly<{
  args: string[];
  env: {
    [key: string]: string;
  };
  root: string;
  signal: AbortSignal;
}>;
class ModelFixtureFailure extends Data.TaggedError("ModelFixtureFailure")<{
  reason: string;
  diagnostics: Option.Option<NativeDiagnostics>;
}> {}
class NativeBoundaryFailure extends Data.TaggedError("NativeBoundaryFailure")<{}> {}
const safeFailureReason = <E>(cause: Cause.Cause<E>): string => {
  const defect = Cause.findDefect(cause);
  if (Result.isSuccess(defect) && Schema.isSchemaError(defect.success)) {
    return "schema_decode_failure";
  }
  if (Result.isSuccess(defect) && defect.success instanceof ModelFixtureFailure) {
    return defect.success.reason;
  }
  if (Result.isSuccess(defect) && defect.success instanceof Error) {
    const message = defect.success.message;
    const known = [
      "unsupported version",
      "missing budget",
      "missing tool",
      "incomplete tools",
      "command failed",
      "output bound",
      "callback bound",
      "login incomplete",
      "unexpected tools",
      "request bound",
      "daemon ownership",
      "daemon version",
      "native state.output bound",
    ];
    if (known.includes(message)) return message;
  }
  return Option.match(Cause.findErrorOption(cause), {
    onNone: () => "internal_failure",
    onSome: (error) => {
      if (error instanceof ModelFixtureFailure) return error.reason;
      if (error instanceof NativeBoundaryFailure) return "native_io_failure";
      return "platform_failure";
    },
  });
};
const foreign = <A>(run: () => Promise<A>): Effect.Effect<A, NativeBoundaryFailure> =>
  Effect.tryPromise({
    try: run,
    catch: () => new NativeBoundaryFailure(),
  });
const command = ({
  args,
  env,
  root,
  signal,
}: CommandInput): Effect.Effect<string, NativeBoundaryFailure | Cause.TimeoutError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (signal.aborted) return yield* Effect.die("interrupted");
      const child = Bun.spawn(args, {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "ignore",
      });
      const abort = (): void => {
        child.kill();
      };
      signal.addEventListener("abort", abort, {
        once: true,
      });
      return yield* Effect.gen(function* () {
        const decoder = new TextDecoder();
        let bytes = 0;
        const chunks = yield* Stream.runCollect(
          Stream.fromReadableStream({
            evaluate: () => child.stdout,
            onError: () => new NativeBoundaryFailure(),
          }).pipe(
            Stream.mapEffect((chunk) => {
              bytes += chunk.byteLength;
              return bytes > outputLimit
                ? Effect.fail(new NativeBoundaryFailure())
                : Effect.succeed(decoder.decode(chunk, { stream: true }));
            })
          )
        );
        const output = chunks.join("") + decoder.decode();
        if ((yield* foreign(() => child.exited)) !== 0) {
          throw new Error("command failed");
        }
        return output;
      }).pipe(
        Effect.ensuring(
          stopProcess(child).pipe(
            Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", abort))),
            Effect.orDie
          )
        )
      );
    }).pipe(Effect.timeout(commandTimeout))
  );
const wait = (_signal: AbortSignal): Effect.Effect<void, never, never> => Effect.sleep(100);
const stopProcess = (child: Bun.Subprocess): Effect.Effect<void, NativeBoundaryFailure, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (child.exitCode === null) child.kill("SIGTERM");
      yield* foreign(() => child.exited).pipe(
        Effect.timeoutOption(killDelay),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(function () {
            if (child.exitCode === null) child.kill("SIGKILL");
          }).pipe(Effect.orDie)
        )
      );
      yield* foreign(() => child.exited);
    })
  );
type NativeInput = Readonly<{
  host: NativeHost;
  binary: string;
  root: string;
}>;
const checkVersion = (
  { host, binary, root }: NativeInput,
  signal: AbortSignal
): Effect.Effect<void, NativeBoundaryFailure | Cause.TimeoutError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const version = yield* command({
        args: [binary, "--version"],
        env: environment(host, root),
        root,
        signal,
      });
      if (!version.split(/\s/u).includes(pinnedVersions[host])) {
        throw new Error("unsupported version");
      }
    })
  );
const prepareProfile = (
  host: NativeHost,
  root: string,
  mcpUrl: string
): Effect.Effect<
  void,
  PlatformError.PlatformError | NativeBoundaryFailure,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(root, {
        recursive: true,
        mode: privateDirectoryMode,
      });
      yield* fs.chmod(root, privateDirectoryMode);
      const profile = profilePath(host, root);
      yield* fs.makeDirectory(profile, {
        recursive: true,
        mode: privateDirectoryMode,
      });
      if (host === "claude") {
        const config = join(profile, ".claude.json");
        const previous = (yield* foreign(() => Bun.file(config).exists()))
          ? object(parseJson(yield* fs.readFileString(config)))
          : {};
        yield* privateWrite(
          config,
          stringify({
            ...previous,
            hasCompletedOnboarding: true,
            theme: "dark",
            mcpServers: {
              fidy: {
                type: "http",
                url: mcpUrl,
                oauth: {
                  scopes: "read write dashboard",
                },
              },
            },
            projects: {
              [resolve(root)]: {
                hasTrustDialogAccepted: true,
                allowedTools: ["mcp__fidy__*"],
              },
            },
          })
        );
      } else {
        yield* privateWrite(
          join(profile, "config.toml"),
          `mcp_oauth_credentials_store="file"\n[mcp_servers.fidy]\nrequired=true\nurl=${stringify(mcpUrl)}\n`
        );
      }
    })
  );
type LoginState = {
  output: string;
  urlWritten: boolean;
  callbackSent: boolean;
};
const publishAuthorization = (
  state: LoginState,
  path: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (state.urlWritten) return;
      const url = state.output
        .match(/https:\/\/api\.fidyapp\.com\/oauth\/authorize\?\S+/u)?.[0]
        ?.split(/\p{Cc}/u)[0];
      if (url !== undefined && url.length > 0) {
        yield* privateWrite(path, url);
        state.urlWritten = true;
      }
    })
  );
const deliverCallback = (
  state: LoginState,
  terminal: Bun.Terminal,
  path: string
): Effect.Effect<
  void,
  PlatformError.PlatformError | NativeBoundaryFailure,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (state.callbackSent || !(yield* foreign(() => Bun.file(path).exists()))) return;
      const fs = yield* FileSystem.FileSystem;
      const value = (yield* fs.readFileString(path)).trim();
      if (value.length > callbackLimit) throw new Error("callback bound");
      terminal.write(`${value}\r`);
      state.callbackSent = true;
    })
  );
type LoginPoll = Readonly<{
  state: LoginState;
  terminal: Bun.Terminal;
  child: Bun.Subprocess;
  deadline: number;
  root: string;
  host: NativeHost;
}>;
const pollLogin = (
  input: LoginPoll,
  signal: AbortSignal
): Effect.Effect<
  void,
  PlatformError.PlatformError | NativeBoundaryFailure,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (input.child.exitCode !== null || now() >= input.deadline) return;
      if (input.state.output.length > outputLimit) throw new Error("output bound");
      yield* publishAuthorization(input.state, join(input.root, `${input.host}-authorize-url.txt`));
      yield* deliverCallback(
        input.state,
        input.terminal,
        join(input.root, `${input.host}-callback-url.txt`)
      );
      yield* wait(signal);
      return yield* pollLogin(input, signal);
    })
  );
const createTerminal = (state: { output: string }): Bun.Terminal =>
  new Bun.Terminal({
    cols: 140,
    rows: 45,
    data: (_terminal, bytes): void => {
      state.output += new TextDecoder().decode(bytes);
    },
  });
const resetLoginFiles = (
  host: NativeHost,
  root: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      [`${host}-authorize-url.txt`, `${host}-callback-url.txt`],
      (name) => fs.remove(join(root, name), { force: true }),
      { discard: true }
    );
  });
const runLogin = (input: NativeInput, signal: AbortSignal): LoginEffect =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, binary, root } = input;
      yield* prepareProfile(host, root, productionUrl);
      yield* checkVersion(input, signal);
      yield* resetLoginFiles(host, root);
      const state: LoginState = {
        output: "",
        urlWritten: false,
        callbackSent: false,
      };
      const terminal = createTerminal(state);
      const child = Bun.spawn(
        [
          binary,
          "mcp",
          "login",
          "fidy",
          "--no-browser",
          ...(host === "codex" ? ["--scopes", "read,write,dashboard"] : []),
        ],
        {
          cwd: root,
          env: environment(host, root),
          terminal,
        }
      );
      return yield* Effect.gen(function* () {
        yield* pollLogin(
          {
            state,
            terminal,
            child,
            deadline: now() + loginTimeout,
            root,
            host,
          },
          signal
        );
        if (child.exitCode !== 0 || !state.urlWritten || !state.callbackSent) {
          throw new Error("login incomplete");
        }
        return {
          host,
          passed: true,
        };
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stopProcess(child);
            terminal.close();
          }).pipe(Effect.orDie)
        )
      );
    })
  );
/** Starts isolated native OAuth. The caller concurrently approves the private authorization URL and writes the host callback file. */
export const nativeLogin = (
  ...args: [host: NativeHost, binary: string, root: string]
): Effect.Effect<
  {
    host: NativeHost;
    passed: boolean;
  },
  NativeProofError,
  FileSystem.FileSystem
> => {
  const [host, binary, root] = args;
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* runLogin(
        {
          host,
          binary,
          root,
        },
        yield* Effect.abortSignal
      );
    }).pipe(
      Effect.catchCause(() =>
        Effect.fail(
          new NativeProofError({
            reason: "native_failure",
            host,
            phase: "login",
            diagnostics: Option.none(),
          })
        )
      )
    )
  );
};
type PlannedTool = Readonly<{
  name: string;
  args: Schema.Json;
}>;
const transactionCalls = ({
  callIds,
  occurredAt,
  namespace,
}: Readonly<{
  callIds: readonly [string, string];
  occurredAt: string;
  namespace: string;
}>): ReadonlyArray<Schema.Json> =>
  [
    { callId: callIds[0], amount: transactionAmounts[0] },
    { callId: callIds[1], amount: transactionAmounts[1] },
  ].map(({ callId, amount }) => ({
    callId,
    operation: "transactions.createTransaction",
    input: {
      payload: {
        money: {
          amount,
          currency: "COP",
        },
        direction: "outflow",
        occurredAt,
        notes: namespace,
      },
    },
  }));
const plannedBudget = (host: NativeHost): PlannedTool => ({
  name: "createBudget",
  args: {
    payload: {
      categoryId: budgetCategories[host],
      cap: {
        amount: "1000",
        currency: "COP",
      },
    },
  },
});
const toolPlan = ({
  host,
  mode,
  namespace,
  budgetId,
  callIds,
  occurredAt,
}: ToolPlanInput): ReadonlyArray<PlannedTool> => {
  const read = {
    name: "listCategories",
    args: {},
  };
  if (mode === "repeat") {
    return Array.from(
      {
        length: host === "claude" ? claudeRepeat : codexRepeat,
      },
      () => read
    );
  }
  if (mode === "refresh") return [read];
  if (mode !== "journey") {
    return [
      {
        name: "deleteBudget",
        args: {
          params: {
            id: budgetId,
          },
        },
      },
    ];
  }
  return [
    read,
    plannedBudget(host),
    {
      name: "executeAtomicBatch",
      args: {
        payload: {
          calls: transactionCalls({
            callIds,
            occurredAt,
            namespace,
          }),
        },
      },
    },
  ];
};
const parseEmbedded = (value: string): Option.Option<Schema.Json> =>
  Result.match(
    Schema.decodeResult(Schema.fromJsonString(Schema.Json))(
      value.split("Output:\n").at(-1) ?? value
    ),
    { onFailure: () => Option.none(), onSuccess: Option.some }
  );
const findId = (value: Schema.Json): string => {
  if (typeof value === "string") {
    return Option.match(parseEmbedded(value), { onNone: () => "", onSome: findId });
  }
  const fields = object(value);
  if (typeof fields.id === "string" && /^[\da-f-]{36}$/iu.test(fields.id)) return fields.id;
  for (const child of Schema.is(ModelJsonArray)(value) ? value : Object.values(fields)) {
    const id = findId(child);
    if (id.length > 0) return id;
  }
  return "";
};
const failedOutput = (value: Schema.Json): boolean => {
  if (typeof value === "string") {
    return Option.match(parseEmbedded(value), { onNone: () => false, onSome: failedOutput });
  }
  const fields = object(value);
  if (fields.is_error === true || fields.isError === true) return true;
  return (Schema.is(ModelJsonArray)(value) ? value : Object.values(fields)).some(failedOutput);
};
const sse = (events: ReadonlyArray<Schema.Json>): string =>
  events.map((event) => `data: ${stringify(event)}\n\n`).join("");
const responseEvents = (item: Schema.Json): string =>
  sse([
    {
      type: "response.created",
      response: {
        id: "fixture_response",
      },
    },
    {
      type: "response.output_item.done",
      item,
    },
    {
      type: "response.completed",
      response: {
        id: "fixture_response",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: null,
          output_tokens_details: null,
        },
      },
    },
  ]);
const anthropicStart = (model: string): Schema.Json => ({
  type: "message_start",
  message: {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 0,
    },
  },
});
const anthropicEvents = ({ model, tool, args, step }: AnthropicEventsInput): string => {
  const toolName = Option.getOrElse(tool, () => "");
  const content: Schema.Json =
    toolName.length > 0
      ? {
          type: "tool_use",
          id: `fixture_${step}`,
          name: toolName,
          input: {},
        }
      : {
          type: "text",
          text: "Journey fixture finished.",
        };
  const events: ReadonlyArray<Schema.Json> = [
    anthropicStart(model),
    {
      type: "content_block_start",
      index: 0,
      content_block: content,
    },
    {
      type: "content_block_delta",
      index: 0,
      delta:
        toolName.length > 0
          ? {
              type: "input_json_delta",
              partial_json: stringify(args),
            }
          : {
              type: "text_delta",
              text: "Journey fixture finished.",
            },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "message_delta",
      delta: {
        stop_reason: toolName.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 20,
      },
    },
    {
      type: "message_stop",
    },
  ];
  return events
    .map((event) => `event: ${text(object(event).type ?? "")}\ndata: ${stringify(event)}\n\n`)
    .join("");
};
type ToolInput = NativeInput &
  Readonly<{
    mode: NativeMode;
    namespace: string;
    mcpUrl: string;
    budgetFile: string;
    plan: ReadonlyArray<PlannedTool>;
  }>;
type ModelState = {
  outputs: ReadonlyArray<Schema.Json>;
  budgetId: string;
  requests: number;
  invoked: number;
  failed: boolean;
  failureReason: string;
  stage: string;
  requestBytes: number;
  catalogSize: number;
  toolNames: ReadonlyArray<string>;
  inputTypes: ReadonlyArray<string>;
  startup: NativeStartup;
  mainModelRequests: number;
  countTokenRequests: number;
  probeRequests: number;
};
const retainBudget = (
  input: ToolInput,
  state: ModelState
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (input.mode !== "journey" || state.outputs[1] === undefined) return;
      state.budgetId = findId(state.outputs[1]) || state.budgetId;
      if (state.budgetId.length > 0) {
        yield* privateWrite(
          input.budgetFile,
          stringify({
            id: state.budgetId,
          })
        );
      }
    })
  );
type JsonObject = {
  readonly [key: string]: Schema.Json;
};
type ModelTool = Readonly<{
  value: JsonObject;
  namespace: string;
}>;
const modelOutputs = (host: NativeHost, body: JsonObject): ReadonlyArray<Schema.Json> => {
  if (host === "codex") {
    return array(body.input ?? []).filter((item) => object(item).type === "function_call_output");
  }
  return array(body.messages ?? [])
    .flatMap((message) => array(object(message).content ?? []))
    .filter((item) => object(item).type === "tool_result");
};
// Only host payload fields contain serialized JSON. Ordinary scalar fields inside a
// canonical result (labels, UUIDs, notes) must never be interpreted as JSON documents.
const canonicalPayload = (value: Schema.Json, depth = 0): Option.Option<Schema.Json> => {
  if (depth > maximumResultDepth) return Option.none();
  if (Predicate.isString(value)) {
    return Option.flatMap(parseEmbedded(value), (parsed) => canonicalPayload(parsed, depth + 1));
  }
  if (Schema.is(ModelJsonArray)(value)) {
    const blocks = value.filter(Schema.is(TextResult));
    const block = blocks[0];
    return blocks.length === 1 && block !== undefined
      ? canonicalPayload(block.text, depth + 1)
      : Option.none();
  }
  return Schema.is(ModelJsonObject)(value) ? objectPayload(value, depth) : Option.none();
};
const objectPayload = (value: JsonObject, depth: number): Option.Option<Schema.Json> => {
  if (value.structuredContent !== undefined) {
    return canonicalPayload(value.structuredContent, depth + 1);
  }
  if (value.content !== undefined) return canonicalPayload(value.content, depth + 1);
  return Option.some(value);
};
const validPlannedOutput = ({
  host,
  plan,
  value,
  refusal,
}: Readonly<{
  host: NativeHost;
  plan: PlannedTool;
  value: Schema.Json;
  refusal: boolean;
}>): boolean => {
  const envelope =
    host === "claude"
      ? Result.match(Schema.decodeUnknownResult(ClaudeToolResult)(value), {
          onFailure: () => Option.none(),
          onSuccess: (result) => Option.some(result.content),
        })
      : Result.match(Schema.decodeUnknownResult(CodexToolResult)(value), {
          onFailure: () => Option.none(),
          onSuccess: (result) => Option.some(result.output),
        });
  const payload = Option.flatMap(envelope, (result) => canonicalPayload(result));
  const operation = operationCatalog.operations.find((candidate) =>
    candidate.id.endsWith(`.${plan.name}`)
  );
  if (operation === undefined || Option.isNone(payload)) return false;
  const schema = Schema.make(
    SchemaAST.toEncoded((refusal ? operation.failure : operation.success).ast)
  );
  return (
    Schema.is(schema)(payload.value) &&
    (refusal ? refusalCode(payload.value) : !failedOutput(value))
  );
};
const flattenTools = (tools: ReadonlyArray<Schema.Json>): ReadonlyArray<ModelTool> =>
  tools.flatMap((tool) => [
    {
      value: object(tool),
      namespace: "",
    },
    ...array(object(tool).tools ?? []).map((child) => ({
      value: object(child),
      namespace: text(object(tool).name ?? ""),
    })),
  ]);
const mergeOutputs = (
  host: NativeHost,
  previous: ReadonlyArray<Schema.Json>,
  current: ReadonlyArray<Schema.Json>
): ReadonlyArray<Schema.Json> => {
  const key = (item: Schema.Json): string =>
    text(object(item)[host === "codex" ? "call_id" : "tool_use_id"] ?? "");
  const entries = new Map(previous.map((item) => [key(item), item]));
  for (const item of current) {
    const id = key(item);
    if (id.length > 0) entries.set(id, item);
  }
  return [...entries.values()];
};
const modelItem = (
  found: Option.Option<ModelTool>,
  args: Schema.Json,
  step: number
): Schema.Json => {
  if (Option.isNone(found)) {
    return {
      type: "message",
      role: "assistant",
      id: "fixture_message",
      content: [
        {
          type: "output_text",
          text: "Journey fixture finished.",
        },
      ],
    };
  }
  const tool = found.value;
  return {
    type: "function_call",
    call_id: `fixture_${step}`,
    name: text(tool.value.name ?? ""),
    arguments: stringify(args),
    ...(tool.namespace.length > 0
      ? {
          namespace: tool.namespace,
        }
      : {}),
  };
};
const catalogMissingPlannedTool = (
  check: Readonly<{
    target: Option.Option<PlannedTool>;
    candidate: Option.Option<ModelTool>;
    invoked: number;
    catalogSize: number;
  }>
): boolean =>
  Option.isSome(check.target) &&
  Option.isNone(check.candidate) &&
  check.invoked > 0 &&
  check.catalogSize > 0;
const cannedResponse = (input: ToolInput, state: ModelState, body: JsonObject): Response => {
  const catalog = flattenTools(array(body.tools ?? []));
  const target = Option.fromUndefinedOr(input.plan[state.outputs.length]);
  const candidate = Option.flatMap(target, (value) =>
    Option.fromUndefinedOr(catalog.find((tool) => text(tool.value.name ?? "").endsWith(value.name)))
  );
  if (
    catalogMissingPlannedTool({
      target,
      candidate,
      invoked: state.invoked,
      catalogSize: catalog.length,
    })
  ) {
    throw new Error("missing tool");
  }
  const found = state.invoked > state.outputs.length ? Option.none<ModelTool>() : candidate;
  if (Option.isSome(found)) state.invoked += 1;
  const args = Option.match(target, {
    onNone: () => ({}),
    onSome: (value) => value.args,
  });
  const tool = Option.map(found, (value) => text(value.value.name ?? ""));
  const response =
    input.host === "codex"
      ? responseEvents(modelItem(found, args, state.outputs.length))
      : anthropicEvents({
          model: text(body.model ?? ""),
          tool,
          args,
          step: state.outputs.length,
        });
  return new Response(response, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
};
const isModelPath = (pathname: string): boolean =>
  ["/v1/messages", "/v1/messages/count_tokens", "/v1/responses"].includes(pathname);
const nonModelResponse = (request: Request): Option.Option<Response> => {
  if (["HEAD", "OPTIONS"].includes(request.method)) {
    return Option.some(new Response(undefined, { status: 204 }));
  }
  if (request.method !== "POST" || !isModelPath(new URL(request.url).pathname)) {
    return Option.some(Response.json({ error: "not_found" }, { status: 404 }));
  }
  return Option.none();
};
const retainCatalog = Effect.fn(function* (input: ToolInput, state: ModelState, body: JsonObject) {
  const catalog = array(body.tools ?? []);
  const catalogSize = flattenTools(catalog).length;
  if (catalogSize > state.catalogSize) {
    yield* privateWrite(join(input.root, `${input.host}-catalog-private.json`), stringify(catalog));
    state.catalogSize = catalogSize;
    state.toolNames = flattenTools(catalog)
      .map((tool) => text(tool.value.name ?? ""))
      .filter((name) => /^[a-zA-Z0-9_.-]{1,160}$/u.test(name));
  }
});
const serveModel = (
  input: ToolInput,
  state: ModelState,
  request: Request
): Effect.Effect<
  Response,
  PlatformError.PlatformError | NativeBoundaryFailure,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (++state.requests > 100) throw new Error("request bound");
      const probe = nonModelResponse(request);
      if (Option.isSome(probe)) {
        state.probeRequests += 1;
        return probe.value;
      }
      state.stage = "read_request";
      const raw = yield* foreign(() => request.text());
      state.requestBytes = new TextEncoder().encode(raw).byteLength;
      state.stage = "parse_request";
      const parsed = parseJson(raw);
      if (!Schema.is(HostModelRequest)(parsed) || !Schema.is(ModelJsonObject)(parsed)) {
        throw new Error("invalid host request");
      }
      const body = parsed;
      state.inputTypes = array(body.input ?? [])
        .map((value) => text(object(value).type ?? ""))
        .filter((name) => ["function_call_output", "function_call", "message"].includes(name));
      if (new URL(request.url).pathname.endsWith("count_tokens")) {
        state.countTokenRequests += 1;
        return Response.json({
          input_tokens: 100,
        });
      }
      state.mainModelRequests += 1;
      state.stage = "retain_catalog";
      yield* retainCatalog(input, state, body);
      state.outputs = mergeOutputs(input.host, state.outputs, modelOutputs(input.host, body));
      yield* retainBudget(input, state);
      if (state.outputs.length > input.plan.length) throw new Error("unexpected tools");
      state.stage = "canned_response";
      return cannedResponse(input, state, body);
    })
  );
const modelServer = (
  input: ToolInput,
  state: ModelState
): Effect.Effect<ReturnType<typeof Bun.serve>, never, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem>();
      return Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 8_388_608,
        fetch: (request): Promise<Response> =>
          Effect.runPromiseWith(context)(
            serveModel(input, state, request).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  state.failed = true;
                  state.failureReason = state.stage + ":" + safeFailureReason(cause);
                  yield* privateWrite(
                    join(input.root, `${input.host}-model-failure-safe.json`),
                    stringify({
                      stage: state.stage,
                      reason: safeFailureReason(cause),
                      requestBytes: state.requestBytes,
                      toolNames: state.toolNames,
                      inputTypes: state.inputTypes,
                      invoked: state.invoked,
                      outputs: state.outputs.length,
                      method: ["GET", "POST", "HEAD", "OPTIONS"].includes(request.method)
                        ? request.method
                        : "other",
                      jsonContentType:
                        request.headers.get("content-type")?.startsWith("application/json") ===
                        true,
                      gzip: request.headers.get("content-encoding") === "gzip",
                      messagesEndpoint: new URL(request.url).pathname.endsWith("messages"),
                    })
                  ).pipe(Effect.orDie);
                  return Response.json(
                    {
                      error: "fixture_failed",
                    },
                    {
                      status: 500,
                    }
                  );
                })
              )
            )
          ),
      });
    })
  );
type DaemonState = {
  owned: boolean;
};
const daemonVersion = (
  input: NativeInput,
  signal: AbortSignal
): Effect.Effect<typeof DaemonMetadata.Type, NativeBoundaryFailure | Cause.TimeoutError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const raw = yield* command({
        args: [input.binary, "app-server", "daemon", "version"],
        env: environment(input.host, input.root),
        root: input.root,
        signal,
      });
      return yield* Schema.decodeEffect(Schema.fromJsonString(DaemonMetadata))(raw).pipe(
        Effect.mapError(() => new NativeBoundaryFailure())
      );
    })
  );
const pinDaemon = (
  input: ToolInput,
  daemon: DaemonState,
  signal: AbortSignal
): Effect.Effect<void, NativeBoundaryFailure | Cause.TimeoutError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { binary, root } = input;
      const env = environment(input.host, root);
      yield* command({
        args: [binary, "app-server", "daemon", "start"],
        env,
        root,
        signal,
      });
      const initial = yield* daemonVersion(input, signal);
      if (!resolve(initial.managedCodexPath).startsWith(`${profilePath(input.host, root)}${sep}`)) {
        throw new Error("daemon ownership");
      }
      daemon.owned = true;
      yield* command({
        args: [binary, "app-server", "daemon", "update", "--from-cli", "--yes"],
        env,
        root,
        signal,
      });
      const updated = yield* daemonVersion(input, signal);
      if (updated.appServerVersion !== pinnedVersions.codex) throw new Error("daemon version");
    })
  );
const restoreClaudeStartup = Effect.fn(function* (input: ToolInput) {
  const fs = yield* FileSystem.FileSystem;
  const config = join(profilePath(input.host, input.root), ".claude.json");
  const previous = object(parseJson(yield* fs.readFileString(config)));
  const projects = object(previous.projects ?? {});
  const project = object(projects[resolve(input.root)] ?? {});
  yield* privateWrite(
    config,
    stringify({
      ...previous,
      theme: "dark",
      hasCompletedOnboarding: true,
      projects: {
        ...projects,
        [resolve(input.root)]: {
          ...project,
          hasTrustDialogAccepted: true,
          allowedTools: ["mcp__fidy__*"],
        },
      },
    })
  );
});
const prepareTools = (
  input: ToolInput,
  daemon: DaemonState,
  context: Readonly<{
    modelUrl: string;
    signal: AbortSignal;
  }>
): Effect.Effect<
  void,
  PlatformError.PlatformError | NativeBoundaryFailure | Cause.TimeoutError,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { modelUrl, signal } = context;
      const { host, root } = input;
      const env = environment(host, root);
      if (host === "claude") {
        if (
          yield* foreign(() => Bun.file(join(profilePath(host, root), ".claude.json")).exists())
        ) {
          yield* restoreClaudeStartup(input);
        }
        Object.assign(env, {
          ANTHROPIC_API_KEY: "disposable-fixture-not-real",
          ANTHROPIC_BASE_URL: modelUrl,
          ENABLE_TOOL_SEARCH: "false",
        });
        return;
      }
      {
        const config =
          `mcp_oauth_credentials_store="file"\nmodel="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Loopback fixture"\nbase_url="${modelUrl}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.fidy]\nrequired=true\nurl=${stringify(input.mcpUrl)}\n[projects.${stringify(resolve(root))}]\ntrust_level="trusted"\n` +
          [
            "categories.listCategories",
            "budgets.createBudget",
            "operations.executeAtomicBatch",
            "budgets.deleteBudget",
          ]
            .map(
              (name) => `\n[mcp_servers.fidy.tools.${stringify(name)}]\napproval_mode="approve"\n`
            )
            .join("");
        yield* privateWrite(join(profilePath(host, root), "config.toml"), config);
        yield* pinDaemon(input, daemon, signal);
      }
    })
  );
type PtyState = {
  output: string;
  answered: boolean;
  apiKeyAllowed: boolean;
  mcpAllowed: boolean;
  lastWarm: number;
};
type PtyInput = Readonly<{
  host: NativeHost;
  mode: NativeMode;
  terminal: Bun.Terminal;
  child: Bun.Subprocess;
  deadline: number;
  model: ModelState;
  expected: number;
  prompt: string;
}>;
const answerForm = (
  input: PtyInput,
  state: PtyState,
  compact: string
): Effect.Effect<void, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (state.answered || input.mode === "headless" || !compact.includes("Confirmarlaacción")) {
        return;
      }
      yield* Effect.sleep(formDelay);
      if (input.mode === "cancel") input.terminal.write("\x1b");
      else if (input.host === "claude") {
        input.terminal.write(" ");
        yield* Effect.sleep(keyDelay);
        input.terminal.write("\x1b[B");
        yield* Effect.sleep(keyDelay);
        input.terminal.write("\r");
      } else {
        input.terminal.write("\x1b[A");
        yield* Effect.sleep(keyDelay);
        input.terminal.write("\r");
      }
      state.answered = true;
    })
  );
const terminalText = (output: string): string =>
  output
    .replace(new RegExp(terminalEscape + "\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "gu"), "")
    .replace(
      new RegExp(terminalEscape + "\\[[0-?]*[ -/]*[@-~]|" + terminalEscape + "[78]", "gu"),
      ""
    );
const compactOutput = (output: string): string => terminalText(output).replace(/\s/gu, "");
const allowClient = (input: PtyInput, state: PtyState, compact: string): void => {
  if (!state.apiKeyAllowed && compact.includes("DoyouwanttousethisAPIkey?")) {
    input.terminal.write("\x1b[A\r");
    state.apiKeyAllowed = true;
  }
  if (!state.mcpAllowed && compact.includes("AllowthefidyMCPserver")) {
    input.terminal.write("\r");
    state.mcpAllowed = true;
  }
};
const classifyStartup = (input: PtyInput, state: PtyState): void => {
  const compact = compactOutput(state.output);
  Object.assign(input.model.startup, {
    apiKeyPrompt: compact.includes("DoyouwanttousethisAPIkey?"),
    mcpApprovalPrompt: compact.includes("AllowthefidyMCPserver"),
    trustPrompt: compact.includes("Doyoutrustthefilesinthisfolder?"),
    onboardingPrompt: compact.includes("WelcometoClaudeCode"),
    themePrompt:
      compact.includes("Choosethetextstyle") ||
      compact.includes("Chooseatheme") ||
      compact.includes("Selectatheme"),
    apiKeyAnswered: state.apiKeyAllowed,
    mcpApprovalAnswered: state.mcpAllowed,
    processExited: input.child.exitCode !== null,
    deadlineReached: now() >= input.deadline,
    exitCode: input.child.exitCode ?? -1,
    exitSignal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(
      input.child.signalCode ?? ""
    )
      ? (input.child.signalCode ?? "none")
      : "none",
    terminalBytes: new TextEncoder().encode(state.output).byteLength,
    failureClasses: startupFailures(compact),
  });
};
const startupFailures = (compact: string): ReadonlyArray<string> => {
  const checks: ReadonlyArray<Readonly<{ code: string; pattern: RegExp }>> = [
    { code: "invalid_mcp_config", pattern: /InvalidMCP|MCPconfiguration|MCPserverconfiguration/iu },
    { code: "unknown_cli_option", pattern: /unknownoption|unrecognizedoption/iu },
    {
      code: "missing_model_auth",
      pattern: /InvalidAPIkey|MissingAPIkey|Notloggedin|authenticationfailed/iu,
    },
    {
      code: "model_request_error",
      pattern: /APIError|APIConnectionError|Connectionerror|Invalidmodel/iu,
    },
    {
      code: "mcp_connect_error",
      pattern:
        /Failedtoconnect|MCPconnectionfailed|MCPserverfailed|MCPstartupfailed|MCPstartupincomplete|MCPclientfor.{0,180}failedtostart/iu,
    },
    { code: "invalid_oauth_scope", pattern: /invalid_scope|invalidscope/iu },
    {
      code: "invalid_tool_schema",
      pattern: /Invalidtoolschema|invalidtoolname|invalidinput_schema/iu,
    },
    {
      code: "profile_config_error",
      pattern: /Invalidconfiguration|Failedtoloadconfig|Errorloadingconfig|SyntaxError/iu,
    },
    {
      code: "native_runtime_error",
      pattern: /Unhandled|TypeError|ReferenceError|RangeError|Segmentationfault|Fatalerror/iu,
    },
  ];
  return checks.filter((check) => check.pattern.test(compact)).map((check) => check.code);
};
const pollTools = (
  input: PtyInput,
  state: PtyState,
  signal: AbortSignal
): Effect.Effect<void, NativeBoundaryFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      classifyStartup(input, state);
      if (
        input.child.exitCode !== null ||
        now() >= input.deadline ||
        input.model.outputs.length >= input.expected
      ) {
        return;
      }
      if (input.model.failed) {
        return yield* Effect.die(
          new ModelFixtureFailure({ reason: input.model.failureReason, diagnostics: Option.none() })
        );
      }
      if (state.output.length > terminalLimit) {
        throw new Error("native state.output bound");
      }
      const compact = compactOutput(state.output);
      allowClient(input, state, compact);
      yield* answerForm(input, state, compact);
      if (input.model.invoked === 0 && now() - state.lastWarm > warmDelay) {
        input.terminal.write(`${input.prompt}\r`);
        state.lastWarm = now();
      }
      yield* wait(signal);
      return yield* pollTools(input, state, signal);
    })
  );
const nativeArgs = (input: ToolInput): string[] => {
  const { host, binary, mode } = input;
  const prompt = "Run the requested fidy journey now.";
  if (host === "claude") {
    return [
      binary,
      prompt,
      "--allowedTools",
      "mcp__fidy__*",
      "--tools",
      "",
      "--permission-mode",
      "default",
      ...(mode === "headless" ? ["-p"] : []),
    ];
  }
  if (mode === "headless") return [binary, "exec", "--skip-git-repo-check", prompt];
  return [binary, "--no-alt-screen", prompt];
};
const runToolsPty = (
  input: ToolInput,
  model: ModelState,
  context: Readonly<{
    modelUrl: string;
    signal: AbortSignal;
  }>
): Effect.Effect<boolean, NativeBoundaryFailure, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = environment(input.host, input.root);
      if (input.host === "claude") {
        Object.assign(env, {
          ANTHROPIC_API_KEY: "disposable-fixture-not-real",
          ANTHROPIC_BASE_URL: context.modelUrl,
          ENABLE_TOOL_SEARCH: "false",
        });
      }
      const state: PtyState = {
        output: "",
        answered: false,
        apiKeyAllowed: false,
        mcpAllowed: false,
        lastWarm: now(),
      };
      const terminal = createTerminal(state);
      const child = Bun.spawn(nativeArgs(input), {
        cwd: input.root,
        env,
        terminal,
      });
      return yield* Effect.gen(function* () {
        yield* pollTools(
          {
            host: input.host,
            mode: input.mode,
            terminal,
            child,
            deadline: now() + toolsTimeout,
            model,
            expected: input.plan.length,
            prompt: "Run the requested fidy journey now.",
          },
          state,
          context.signal
        );
        return state.answered;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stopProcess(child);
            terminal.close();
          }).pipe(Effect.orDie)
        )
      );
    })
  );
const refusalCode = (value: Schema.Json): boolean => {
  if (typeof value === "string") {
    return Option.match(parseEmbedded(value), { onNone: () => false, onSome: refusalCode });
  }
  const fields = object(value);
  if (fields.code === "user_action_required") return true;
  return (Schema.is(ModelJsonArray)(value) ? value : Object.values(fields)).some(refusalCode);
};
const closedErrorCode = (value: Schema.Json): string => {
  if (typeof value === "string") {
    return Option.match(parseEmbedded(value), { onNone: () => "none", onSome: closedErrorCode });
  }
  const fields = object(value);
  const code = text(fields.code ?? "");
  if (
    [
      "validation_failed",
      "not_found",
      "forbidden",
      "unauthorized",
      "unavailable",
      "conflict",
      "user_action_required",
      "internal_error",
      "invalid_input",
      "rate_limited",
    ].includes(code)
  ) {
    return code;
  }
  for (const child of Schema.is(ModelJsonArray)(value) ? value : Object.values(fields)) {
    const nested = closedErrorCode(child);
    if (nested !== "none") return nested;
  }
  return "none";
};
const toolDiagnostics = (
  input: ToolInput,
  state: ModelState,
  validity: Readonly<{ resultsValid: boolean; formValid: boolean }>
): NativeDiagnostics => {
  const failedIndex = state.outputs.findIndex(failedOutput);
  return {
    requested: input.plan.length,
    received: state.outputs.length,
    invoked: state.invoked,
    requests: state.requests,
    ...validity,
    failedTool: input.plan[failedIndex]?.name ?? "none",
    nextTool: input.plan[state.outputs.length]?.name ?? "none",
    errorCode: closedErrorCode(state.outputs[failedIndex] ?? null),
    modelFailure: state.failureReason,
    startup: state.startup,
    catalogSize: state.catalogSize,
    mainModelRequests: state.mainModelRequests,
    countTokenRequests: state.countTokenRequests,
    probeRequests: state.probeRequests,
    toolNames: state.toolNames,
  };
};
const invalidTools = Effect.fn(function* (
  input: ToolInput,
  state: ModelState,
  validity: Readonly<{ resultsValid: boolean; formValid: boolean }>
) {
  const diagnostics = toolDiagnostics(input, state, validity);
  yield* privateWrite(
    join(input.root, `${input.host}-${input.mode}-failure-safe.json`),
    stringify(diagnostics)
  );
  return yield* Effect.die(
    new ModelFixtureFailure({ reason: "incomplete tools", diagnostics: Option.some(diagnostics) })
  );
});
const nativeToolsFailure = <E>(
  host: NativeHost,
  phase: NativeMode,
  cause: Cause.Cause<E>
): NativeProofError => {
  const defect = Cause.findDefect(cause);
  return new NativeProofError({
    reason: safeFailureReason(cause),
    host,
    phase,
    diagnostics:
      Result.isSuccess(defect) && defect.success instanceof ModelFixtureFailure
        ? defect.success.diagnostics
        : Option.none(),
  });
};
const summarizeTools = (
  input: ToolInput,
  state: ModelState,
  answered: boolean
): Effect.Effect<
  {
    host: NativeHost;
    mode: NativeMode;
    expected: number;
    received: number;
    nativeFormAnswered: boolean;
    passed: boolean;
  },
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, mode, root } = input;
      yield* privateWrite(join(root, `${host}-outputs-private.json`), stringify(state.outputs));
      yield* privateWrite(
        join(root, `${host}-${mode}-outputs-private.json`),
        stringify(state.outputs)
      );
      const refusal = mode === "cancel" || mode === "headless";
      const resultsValid = state.outputs.every((value, index) => {
        const plan = input.plan[index];
        return plan !== undefined && validPlannedOutput({ host, plan, value, refusal });
      });
      const formValid = !["cancel", "accept"].includes(mode) || answered;
      const passed =
        !state.failed && state.outputs.length === input.plan.length && resultsValid && formValid;
      const summary = {
        host,
        mode,
        expected: input.plan.length,
        received: state.outputs.length,
        nativeFormAnswered: answered,
        passed,
      };
      yield* privateWrite(join(root, `${host}-${mode}-safe.json`), stringify(summary));
      if (!passed) {
        return yield* invalidTools(input, state, { resultsValid, formValid });
      }
      return summary;
    })
  );
type ToolsEffect = Effect.Effect<
  NativeSummary,
  PlatformError.PlatformError | NativeBoundaryFailure | Cause.TimeoutError,
  FileSystem.FileSystem
>;
const initialStartup = (): NativeStartup => ({
  apiKeyPrompt: false,
  mcpApprovalPrompt: false,
  trustPrompt: false,
  onboardingPrompt: false,
  themePrompt: false,
  apiKeyAnswered: false,
  mcpApprovalAnswered: false,
  processExited: false,
  deadlineReached: false,
  exitCode: -1,
  exitSignal: "none",
  terminalBytes: 0,
  failureClasses: [],
});
const runTools = (input: ToolInput, signal: AbortSignal): ToolsEffect =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* checkVersion(input, signal);
      const state: ModelState = {
        outputs: [],
        budgetId: text(
          object(
            parseJson(
              yield* fs.readFileString(input.budgetFile).pipe(Effect.orElseSucceed(() => "{}"))
            )
          ).id ?? ""
        ),
        requests: 0,
        invoked: 0,
        failed: false,
        failureReason: "none",
        stage: "idle",
        requestBytes: 0,
        catalogSize: 0,
        toolNames: [],
        inputTypes: [],
        startup: initialStartup(),
        mainModelRequests: 0,
        countTokenRequests: 0,
        probeRequests: 0,
      };
      const server = yield* modelServer(input, state);
      const daemon: DaemonState = {
        owned: false,
      };
      return yield* Effect.gen(function* () {
        const modelUrl = `http://127.0.0.1:${server.port}`;
        yield* prepareTools(input, daemon, {
          modelUrl,
          signal,
        });
        const answered = yield* runToolsPty(input, state, {
          modelUrl,
          signal,
        });
        return yield* summarizeTools(input, state, answered);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* foreign(() => server.stop(true));
            if (daemon.owned) {
              yield* command({
                args: [input.binary, "app-server", "daemon", "stop"],
                env: environment(input.host, input.root),
                root: input.root,
                signal: yield* Effect.abortSignal,
              });
            }
          }).pipe(Effect.orDie)
        )
      );
    })
  );
/** Drives canned model decisions through real native clients. Mutation delivery is never retried; caller reconciles private outputs with canonical state and Audit. */
export const nativeTools = (
  ...values: [
    host: NativeHost,
    binary: string,
    root: string,
    mode: NativeMode,
    namespace: string,
    ...options: NativeOptions[],
  ]
): Effect.Effect<NativeSummary, NativeProofError, FileSystem.FileSystem | Crypto.Crypto> => {
  const [host, binary, root, mode, namespace] = values;
  return Effect.scoped(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const callIds: readonly [string, string] = [
        yield* crypto.randomUUIDv4,
        yield* crypto.randomUUIDv4,
      ];
      const budgetFile = join(root, `${host}-budget-private.json`);
      const budgetId = (yield* foreign(() => Bun.file(budgetFile).exists()))
        ? text(object(parseJson(yield* fs.readFileString(budgetFile))).id ?? "")
        : "";
      if (["cancel", "accept", "headless"].includes(mode) && budgetId.length === 0) {
        throw new Error("missing budget");
      }
      return yield* runTools(
        {
          host,
          binary,
          root,
          mode,
          namespace,
          budgetFile,
          mcpUrl: values[5]?.mcpUrl ?? productionUrl,
          plan: toolPlan({
            host,
            mode,
            namespace,
            budgetId,
            callIds,
            occurredAt: DateTime.formatIso(yield* DateTime.now),
          }),
        },
        signal
      );
    }).pipe(Effect.catchCause((cause) => Effect.fail(nativeToolsFailure(host, mode, cause))))
  );
};
const CredentialShape = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
const readCredential = (
  input: NativeInput,
  signal: AbortSignal
): Effect.Effect<
  Schema.Json,
  PlatformError.PlatformError | NativeBoundaryFailure | Cause.TimeoutError | Config.ConfigError,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { host, root } = input;
      const profile = profilePath(host, root);
      if (host === "codex") {
        const fs = yield* FileSystem.FileSystem;
        return parseJson(yield* fs.readFileString(join(profile, ".credentials.json")));
      }
      const service = `Claude Code-credentials-${new Bun.CryptoHasher("sha256").update(profile.normalize("NFC")).digest("hex").slice(0, hashLength)}`;
      return parseJson(
        yield* command({
          args: [
            "/usr/bin/security",
            "find-generic-password",
            "-a",
            yield* Config.String("USER").pipe(Config.withDefault(userInfo().username)),
            "-s",
            service,
            "-w",
          ],
          env: environment(host, root),
          root,
          signal,
        })
      );
    })
  );
const normalizeCredential = (entry: JsonObject): NativeCredential => {
  const decoded = Schema.decodeUnknownSync(CredentialShape)({
    accessToken: entry.accessToken ?? entry.access_token,
    refreshToken: entry.refreshToken ?? entry.refresh_token,
    clientId: entry.clientId ?? entry.client_id,
    expiresAt: entry.expiresAt ?? entry.expires_at,
  });
  return {
    ...decoded,
    accessToken: Redacted.make(decoded.accessToken),
    refreshToken: Redacted.make(decoded.refreshToken),
  };
};
const selectCredential = (host: NativeHost, raw: Schema.Json): NativeCredential => {
  const store = object(raw);
  const entries = host === "claude" ? object(store.mcpOAuth ?? {}) : store;
  const matches = Object.values(entries)
    .map(object)
    .filter(
      (entry) =>
        (entry.serverName ?? entry.server_name) === "fidy" &&
        (entry.serverUrl ?? entry.server_url) === productionUrl
    );
  if (matches.length !== 1 || matches[0] === undefined) throw new Error("credential ownership");
  return normalizeCredential(matches[0]);
};
/** Reads only this isolated native client's OAuth credential. Secrets remain redacted in memory; never serialize this result. */
export const nativeCredential = (
  ...args: [host: NativeHost, binary: string, root: string]
): Effect.Effect<
  Readonly<{
    accessToken: Redacted.Redacted<string>;
    refreshToken: Redacted.Redacted<string>;
    clientId: string;
    expiresAt: number;
  }>,
  NativeProofError,
  FileSystem.FileSystem
> => {
  const [host, binary, root] = args;
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* readCredential(
        {
          host,
          binary,
          root,
        },
        yield* Effect.abortSignal
      );
    }).pipe(
      Effect.map((raw) => selectCredential(host, raw)),
      Effect.catchCause(() =>
        Effect.fail(
          new NativeProofError({
            reason: "native_failure",
            host,
            phase: "credential",
            diagnostics: Option.none(),
          })
        )
      )
    )
  );
};
export const nativeLogout = (
  ...args: [host: NativeHost, binary: string, root: string]
): Effect.Effect<
  {
    host: NativeHost;
    passed: boolean;
  },
  NativeProofError,
  never
> => {
  const [host, binary, root] = args;
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* command({
        args: [binary, "mcp", "logout", "fidy"],
        env: environment(host, root),
        root,
        signal: yield* Effect.abortSignal,
      });
    }).pipe(
      Effect.as({
        host,
        passed: true,
      }),
      Effect.catchCause(() =>
        Effect.fail(
          new NativeProofError({
            reason: "native_failure",
            host,
            phase: "logout",
            diagnostics: Option.none(),
          })
        )
      )
    )
  );
};
const now = (): number => Effect.runSync(Clock.currentTimeMillis);
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
