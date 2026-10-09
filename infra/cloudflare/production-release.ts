/// <reference types="bun-types" />

import { Cause, Context, Data, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { Hex } from "effect/encoding";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  SmokeIdentity,
  SmokeRequest,
  SmokeResponse,
  smokePath,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { releaseCleanup } from "./release-cleanup";
import { freeTierWorkerObservability } from "./worker-observability";
import { type RollbackPort, RollbackReceipt, releaseRollback } from "./release-rollback";
import { type WorkerResources, rollbackCompatible } from "./rollback-compatibility";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  releaseController,
  releaseSchemas,
} from "./release-controller";

const VersionId = SmokeIdentity.fields.workerVersionId;
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
const ApiDeployment = Schema.Struct({
  id: VersionId,
  versions: Schema.Array(Schema.Struct({ version_id: VersionId, percentage: Schema.Finite })),
});
const ListResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ deployments: Schema.Array(ApiDeployment) }),
});
const CreateResponse = Schema.Struct({ success: Schema.Literal(true), result: ApiDeployment });
const DeployableResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: VersionId })) }),
});
const VersionResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: VersionId,
    resources: Schema.Struct({
      bindings: Schema.Record(Schema.String, Schema.Unknown),
      script_runtime: Schema.Struct({
        migration_tag: Schema.optional(Schema.String),
        exports: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  }),
});
const ResourceIdentity = Schema.Struct({ logicalId: Schema.String });
const ResourceLifecycle = Schema.Struct({
  status: Schema.Literals([
    "creating",
    "created",
    "updating",
    "updated",
    "deleting",
    "replacing",
    "replaced",
  ]),
});
const stableWorkerReceiptStatuses = new Set(["created", "updated", "replaced"]);
// Alchemy `replaced` carries the successfully created generation's attrs; only the old
// generation is pending garbage collection. Capture still independently verifies live traffic.
const ResourceAttributes = Schema.Record(Schema.String, Schema.Unknown);
const WorkerIdentity = Schema.Struct({ workerName: WorkerName });
const StateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literals(["created", "updated", "replaced"]),
  attr: ResourceAttributes,
});
// Interrupted updates retain both the current output and the last-applied output. Capture may
// use them only when their Worker identities agree; completed-receipt consumers reject updates.
const UpdatingStateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literal("updating"),
  attr: ResourceAttributes,
  old: Schema.Struct({ attr: ResourceAttributes }),
});
const StateMap = Schema.Record(Schema.String, Schema.Unknown);
const Commands = Schema.Literals([
  "verify-retirement",
  "capture",
  "stage",
  "promote",
  "rollback",
  "cleanup",
  "report",
  "inspect",
  "isolate",
]);
const SmokeAttestation = Schema.Struct({
  revision: SmokeIdentity.fields.gitRevision,
  publicVersionId: VersionId,
  coreVersionId: VersionId,
});
const healthSchema = Schema.Struct({
  status: Schema.Literal("available"),
  gitRevision: SmokeIdentity.fields.gitRevision,
  contractDigest: SmokeIdentity.fields.contractDigest,
});
const smokeResultSchema = Schema.Struct({ ...SmokeResponse.fields, public: SmokeIdentity });
const responseLimit = 100_000;
const successStatusStart = 200;
const successStatusEnd = 300;
const probeEntropyBytes = 16;
const inspectionHistoryLimit = 5;
const recoveryUnavailableStatus = 503;
const origin = "https://api.fidyapp.com";
class ReleaseFailure extends Data.TaggedError("ReleaseFailure")<{ message: string }> {}

/** CLI failures report only owned release messages, never foreign errors or provider values. */
export const releaseFailureMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof ReleaseFailure) {
      return reason.error.message;
    }
  }
  return "Production release routing failed; inspect Worker deployment state before recovery.";
};

const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Json);
const encodeJson = Schema.encodeSync(Json);

type Config = Readonly<{
  account: string;
  token: string;
  revision: string;
  repository: string;
  githubToken: string;
  file: string;
  smokeProof: string;
  smokeAttestationFile: string;
}>;
const config = (): Config => {
  const environment = process.env;
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      CLOUDFLARE_ACCOUNT_ID: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
      CLOUDFLARE_API_TOKEN: Schema.NonEmptyString,
      RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
      GITHUB_REPOSITORY: Schema.String.check(
        Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u)
      ),
      GITHUB_TOKEN: Schema.NonEmptyString,
      RELEASE_SNAPSHOT_FILE: Schema.String.check(Schema.isPattern(/^\//u)),
      SMOKE_ATTESTATION_FILE: Schema.String.check(Schema.isPattern(/^\//u)),
      SMOKE_PROOF: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    })
  )(environment);
  if (Option.isNone(decoded)) {
    throw Error("Incomplete production release configuration");
  }
  return {
    account: decoded.value.CLOUDFLARE_ACCOUNT_ID,
    token: decoded.value.CLOUDFLARE_API_TOKEN,
    revision: decoded.value.RELEASE_GIT_SHA,
    repository: decoded.value.GITHUB_REPOSITORY,
    githubToken: decoded.value.GITHUB_TOKEN,
    file: decoded.value.RELEASE_SNAPSHOT_FILE,
    smokeProof: decoded.value.SMOKE_PROOF,
    smokeAttestationFile: decoded.value.SMOKE_ATTESTATION_FILE,
  };
};

// Bound the stream before decoding; early termination releases the response stream's scope.
const boundedJson = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status < successStatusStart || response.status >= successStatusEnd) {
    return yield* Effect.fail(Error("Provider rejected the release request"));
  }
  if (Number(response.headers["content-length"] ?? 0) > responseLimit) {
    return yield* Effect.fail(Error("Provider response exceeded limit"));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (value) =>
    Effect.sync(() => {
      size += value.byteLength;
      if (size > responseLimit) return false;
      chunks.push(value);
      return true;
    })
  ).pipe(Effect.mapError(() => Error("Provider response could not be read within limit")));
  if (size > responseLimit) {
    return yield* Effect.fail(Error("Provider response exceeded limit"));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return yield* decodeJson(new TextDecoder().decode(bytes));
});
const providerJson = Effect.fn(
  function* (request: HttpClientRequest.HttpClientRequest) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(Effect.mapError(() => Error("Provider request failed; inspect traffic state")));
    return yield* boundedJson(response);
  },
  Effect.scoped,
  Effect.timeout("10 seconds")
);

/** Script settings are independent of gradual code uploads; verify privacy before staging. */
export const redactReleaseQueries = Effect.fn(function* (
  env: Pick<Config, "account" | "token">,
  names: ReadonlyArray<string>,
  client: HttpClient.HttpClient
) {
  const response = Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Struct({
      observability: Schema.Struct({
        enabled: Schema.Literal(true),
        redact_query_string: Schema.Literal(true),
        logs: Schema.Struct({
          enabled: Schema.Literal(true),
          invocation_logs: Schema.Literal(false),
          persist: Schema.Literal(true),
        }),
      }),
    }),
  });
  for (const name of names) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}`;
    const headers = { authorization: `Bearer ${env.token}` };
    // Patch only privacy metadata. Bindings, code and traffic remain owned by their release gates.
    yield* providerJson(
      HttpClientRequest.patch(`${base}/script-settings`, {
        headers: { ...headers, "content-type": "application/json" },
        body: HttpBody.text(
          encodeJson({
            observability: {
              enabled: freeTierWorkerObservability.enabled,
              head_sampling_rate: freeTierWorkerObservability.headSamplingRate,
              redact_query_string: freeTierWorkerObservability.redactQueryString,
              logs: {
                enabled: freeTierWorkerObservability.logs.enabled,
                head_sampling_rate: freeTierWorkerObservability.logs.headSamplingRate,
                invocation_logs: freeTierWorkerObservability.logs.invocationLogs,
                persist: freeTierWorkerObservability.logs.persist,
              },
              traces: { enabled: false },
            },
          }),
          "application/json"
        ),
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    yield* providerJson(HttpClientRequest.get(`${base}/settings`, { headers })).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flatMap(Schema.decodeUnknownEffect(response)),
      Effect.mapError(
        () =>
          new ReleaseFailure({
            message: "Release staging refused: request query redaction is unverified",
          })
      )
    );
  }
});
// Retain at most 32 KiB in memory; drain the pipe without publishing foreign output.
const toolingRefusal = (stream: ReadableStream<Uint8Array>): Promise<Option.Option<string>> => {
  const decoder = new TextDecoder();
  const limit = 32_768;
  let retained = "";
  let size = 0;
  return stream
    .pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          const bytes = chunk.subarray(0, Math.max(0, limit - size));
          retained += decoder.decode(bytes, { stream: true });
          size += bytes.byteLength;
        },
      })
    )
    .then(() => {
      const output = retained + decoder.decode();
      // Wrangler 4.144.0 rewrites API 100405 as UserError and removes its numeric code.
      return Option.fromNullishOr(output.match(/\[code: (\d{4,6})\]/u)?.[1]).pipe(
        Option.orElse(() =>
          output.includes(
            "All versions in a percentage-split deployment must declare identical Durable Object `exports`."
          )
            ? Option.some("100405")
            : Option.none()
        ),
        // Closed resource categories help diagnose deleted bindings without retaining provider text.
        Option.map((code) => {
          if (/\bqueues?\b/iu.test(output)) return `${code}; resource=queue`;
          if (/\bworkflows?\b/iu.test(output)) return `${code}; resource=workflow`;
          return code;
        })
      );
    });
};

const startReleaseCommand = (
  args: ReadonlyArray<string>
): {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  settlement: Promise<
    [
      PromiseSettledResult<string>,
      PromiseSettledResult<number>,
      PromiseSettledResult<Option.Option<string>>,
    ]
  >;
} => {
  const child = Bun.spawn([...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const settlement = Promise.allSettled([
    new Response(child.stdout).text(),
    child.exited,
    toolingRefusal(child.stderr),
  ]);
  return { child, settlement };
};

/** Own native command output and actual exit; interruption of a started write is not rollback. */
export const releaseCommand = ({
  args,
  lifetime,
}: Readonly<{
  args: ReadonlyArray<string>;
  lifetime: "read-only" | "started-write";
}>): Effect.Effect<string, ReleaseFailure> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => startReleaseCommand(args),
      catch: () => new ReleaseFailure({ message: "Release tooling failed" }),
    }),
    ({ settlement }) =>
      Effect.tryPromise({
        try: () => settlement,
        catch: () => new ReleaseFailure({ message: "Release tooling failed" }),
      }).pipe(
        Effect.flatMap(([output, exit, code]) =>
          output.status === "fulfilled" && exit.status === "fulfilled" && exit.value === 0
            ? Effect.succeed(output.value)
            : Effect.fail(
                new ReleaseFailure({
                  message:
                    code.status === "fulfilled" && Option.isSome(code.value)
                      ? `Release tooling failed (Cloudflare API code ${code.value.value}); inspect traffic state`
                      : "Release tooling failed; inspect traffic state",
                })
              )
        )
      ),
    ({ child, settlement }, exit) =>
      Effect.gen(function* () {
        const cancellation = yield* Effect.exit(
          lifetime === "read-only" && exit._tag === "Failure" && child.exitCode === null
            ? Effect.try({
                try: () => child.kill("SIGTERM"),
                catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
              })
            : Effect.void
        );
        const results = yield* Effect.tryPromise({
          try: () => settlement,
          catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
        });
        if (cancellation._tag === "Failure") return yield* Effect.failCause(cancellation.cause);
        if (results[1].status !== "fulfilled") {
          return yield* new ReleaseFailure({
            message: "Release tooling exit could not be confirmed",
          });
        }
      })
  );
const shell = (args: ReadonlyArray<string>): Effect.Effect<string, ReleaseFailure> =>
  releaseCommand({ args, lifetime: "read-only" });
const readFile = (path: string): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => new ReleaseFailure({ message: "Release snapshot could not be read" }),
  }).pipe(Effect.flatMap(decodeJson));
const writeFile = (path: string | Bun.BunFile, content: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Bun.write(path, content),
    catch: () => new ReleaseFailure({ message: "Release output could not be written" }),
  }).pipe(Effect.asVoid);

type WorkerReceipt = Readonly<{
  workerName: string;
  versionId: Option.Option<string>;
  hasRolloutBaseline: boolean;
}>;
type WorkerReceipts = Readonly<{ public: WorkerReceipt; core: WorkerReceipt }>;
const workerReceiptMessages = {
  Ingress: {
    missing: "Alchemy Ingress Worker resource is missing",
    ambiguous: "Alchemy Ingress Worker receipt is ambiguous",
    unstable: "Alchemy Ingress Worker lifecycle is unstable",
    incomplete: "Alchemy Ingress Worker receipt is incomplete",
  },
  Core: {
    missing: "Alchemy Core Worker resource is missing",
    ambiguous: "Alchemy Core Worker receipt is ambiguous",
    unstable: "Alchemy Core Worker lifecycle is unstable",
    incomplete: "Alchemy Core Worker receipt is incomplete",
  },
} as const;
const safeWorkerReceiptMessages = new Set<string>([
  ...Object.values(workerReceiptMessages.Ingress),
  ...Object.values(workerReceiptMessages.Core),
]);

const decodeStateMap = (output: string): typeof StateMap.Type => {
  const objectStarts = [...output.matchAll(/\{/gu)].map((match) => match.index);

  for (const index of objectStarts) {
    try {
      return Schema.decodeUnknownSync(StateMap)(JSON.parse(output.slice(index).trim()));
    } catch {
      // Alchemy can write credential-refresh progress before its JSON state. Accept only a
      // complete object matching the state-map schema; never include the output in an error.
    }
  }

  throw Error("Alchemy Worker state output is invalid");
};

const interruptedUpdateAttributes = (
  value: unknown,
  logicalId: "Ingress" | "Core"
): typeof ResourceAttributes.Type => {
  const interrupted = Schema.decodeUnknownOption(UpdatingStateEntry)(value);
  if (Option.isNone(interrupted)) throw Error(workerReceiptMessages[logicalId].incomplete);
  const currentIdentity = Schema.decodeUnknownOption(WorkerIdentity)(interrupted.value.attr);
  const previousIdentity = Schema.decodeUnknownOption(WorkerIdentity)(interrupted.value.old.attr);
  if (
    Option.isNone(currentIdentity) ||
    Option.isNone(previousIdentity) ||
    currentIdentity.value.workerName !== previousIdentity.value.workerName
  ) {
    throw Error(workerReceiptMessages[logicalId].incomplete);
  }
  return interrupted.value.attr;
};

const attributesForReceipt = (
  value: unknown,
  logicalId: "Ingress" | "Core",
  mode: "capture" | "completed"
): typeof ResourceAttributes.Type => {
  const decoded = Schema.decodeUnknownOption(StateEntry)(value);
  if (Option.isSome(decoded)) return decoded.value.attr;
  const lifecycle = Schema.decodeUnknownOption(ResourceLifecycle)(value);
  if (Option.isSome(lifecycle) && lifecycle.value.status === "updating" && mode === "capture") {
    return interruptedUpdateAttributes(value, logicalId);
  }
  if (Option.isSome(lifecycle) && !stableWorkerReceiptStatuses.has(lifecycle.value.status)) {
    throw Error(workerReceiptMessages[logicalId].unstable);
  }
  throw Error(workerReceiptMessages[logicalId].incomplete);
};

const decodeWorkerReceiptsWithMode = (
  output: string,
  mode: "capture" | "completed"
): WorkerReceipts => {
  const entries = decodeStateMap(output);
  const select = (logicalId: "Ingress" | "Core"): WorkerReceipt => {
    const matchingEntries = Object.values(entries).filter((value) => {
      const identity = Schema.decodeUnknownOption(ResourceIdentity)(value);
      return Option.isSome(identity) && identity.value.logicalId === logicalId;
    });
    if (matchingEntries.length === 0) throw Error(workerReceiptMessages[logicalId].missing);
    if (matchingEntries.length !== 1) throw Error(workerReceiptMessages[logicalId].ambiguous);

    const attributes = attributesForReceipt(matchingEntries[0], logicalId, mode);
    const identity = Schema.decodeUnknownOption(WorkerIdentity)(attributes);
    if (Option.isNone(identity)) throw Error(workerReceiptMessages[logicalId].incomplete);
    const rawVersion = Schema.decodeUnknownOption(Schema.Struct({ versionId: VersionId }))(
      attributes
    );
    const baseline = Schema.decodeUnknownOption(
      Schema.Struct({ hash: Schema.Record(Schema.String, Schema.Unknown) })
    )(attributes);
    return {
      workerName: identity.value.workerName,
      versionId: Option.map(rawVersion, (entry) => entry.versionId),
      hasRolloutBaseline: Option.isSome(baseline),
    };
  };
  return { public: select("Ingress"), core: select("Core") };
};

export const decodeWorkerReceipts = (output: string): WorkerReceipts =>
  decodeWorkerReceiptsWithMode(output, "completed");

export const decodeCaptureWorkerReceipts = (output: string): WorkerReceipts =>
  decodeWorkerReceiptsWithMode(output, "capture");

const workersFromState = Effect.fn(function* (mode: "capture" | "completed" = "completed") {
  // Alchemy's persisted upload receipts, not a health response. Never print state: it also
  // contains other resources' binding metadata.
  const rawState = yield* shell([
    "bun",
    "../../node_modules/alchemy/bin/alchemy.js",
    "state",
    "read",
    "--backend",
    "cloudflare",
    "--recursive",
    "FidyCloudflare/production",
    "--no-input",
    "--log-level",
    "error",
  ]).pipe(
    Effect.mapError(() => new ReleaseFailure({ message: "Alchemy Worker state command failed" }))
  );
  return yield* Effect.try({
    try: () =>
      mode === "capture" ? decodeCaptureWorkerReceipts(rawState) : decodeWorkerReceipts(rawState),
    catch: (cause) =>
      new ReleaseFailure({
        message:
          cause instanceof Error && safeWorkerReceiptMessages.has(cause.message)
            ? cause.message
            : "Alchemy Worker state JSON could not be decoded",
      }),
  });
});

const stableIdentity = Effect.fn(function* (input: {
  publicVersionId: string;
  coreVersionId: string;
  proof: string;
}) {
  const health = yield* Schema.decodeUnknownEffect(healthSchema)(
    yield* providerJson(HttpClientRequest.get(`${origin}/health`))
  );
  const request = yield* Schema.decodeEffect(SmokeRequest)({
    protocolVersion: 1,
    probeId: Hex.encode(crypto.getRandomValues(new Uint8Array(probeEntropyBytes))),
    expectedPublicVersionId: input.publicVersionId,
    expectedCoreVersionId: input.coreVersionId,
    expectedGitRevision: health.gitRevision,
    expectedContractDigest: health.contractDigest,
  });
  const raw = yield* providerJson(
    HttpClientRequest.post(`${origin}${smokePath}`, {
      headers: { "x-fidy-smoke-proof": input.proof, "content-type": "application/json" },
      body: HttpBody.text(encodeJson(request), "application/json"),
    })
  );
  const observed = yield* Schema.decodeUnknownEffect(smokeResultSchema)(raw);
  const identities = [observed.public, observed.core];
  if (
    observed.public.workerVersionId !== input.publicVersionId ||
    observed.core.workerVersionId !== input.coreVersionId ||
    identities.some(
      (identity) =>
        identity.gitRevision !== health.gitRevision ||
        identity.contractDigest !== health.contractDigest
    )
  ) {
    return yield* Effect.fail(Error("Stable Worker release identities disagree"));
  }
  return { stableRevision: health.gitRevision, stableContractDigest: health.contractDigest };
});

const asDeployment = (value: typeof ApiDeployment.Type): Deployment => ({
  id: value.id,
  versions: value.versions.map((version) => ({
    id: version.version_id,
    percentage: version.percentage,
  })),
});
const createDeployment = Effect.fn(function* (
  json: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<unknown, Error>,
  input: { url: string; token: string; versions: Deployment["versions"] }
) {
  const raw = yield* json(
    HttpClientRequest.post(input.url, {
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: HttpBody.text(
        encodeJson({
          strategy: "percentage",
          versions: input.versions.map((version) => ({
            version_id: version.id,
            percentage: version.percentage,
          })),
        }),
        "application/json"
      ),
    })
  );
  const response = yield* Schema.decodeUnknownEffect(CreateResponse)(raw);
  return asDeployment(response.result);
});
const readTrunk = Effect.fn(function* (env: Config) {
  // Full commit responses contain file patches whose size grows with the commit.
  const raw = yield* providerJson(
    HttpClientRequest.get(`https://api.github.com/repos/${env.repository}/git/ref/heads/trunk`, {
      headers: {
        authorization: `Bearer ${env.githubToken}`,
        accept: "application/vnd.github+json",
      },
    })
  );
  const response = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      ref: Schema.Literal("refs/heads/trunk"),
      object: Schema.Struct({
        type: Schema.Literal("commit"),
        sha: SmokeIdentity.fields.gitRevision,
      }),
    })
  )(raw);
  return response.object.sha;
});

/** Authenticated routing adapter with bounded reads and validated release identities. */
export const releasePort = ({
  env,
  client,
}: {
  env: Config;
  client: HttpClient.HttpClient;
}): ReleasePort => {
  const json = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<unknown, Error> =>
    providerJson(request).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const url = (name: string): string =>
    `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`;
  const current: ReleasePort["current"] = (name) =>
    Effect.gen(function* () {
      const raw = yield* json(
        HttpClientRequest.get(url(name), {
          headers: { authorization: `Bearer ${env.token}` },
        })
      );
      const response = yield* Schema.decodeUnknownEffect(ListResponse)(raw);
      const active = response.result.deployments[0];
      if (active === undefined) return yield* Effect.fail(Error(`No active deployment: ${name}`));
      return asDeployment(active);
    });
  return {
    trunk: () => readTrunk(env).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    current,
    deploy: (name, versions) =>
      Effect.gen(function* () {
        if (versions.some((version) => version.percentage === 0)) {
          // Cloudflare documents 0% through Wrangler, but its create-deployment API schema
          // specifies a nonzero minimum. Never substitute 0.01%.
          yield* releaseCommand({
            args: [
              "bun",
              "../../node_modules/wrangler/bin/wrangler.js",
              "versions",
              "deploy",
              ...versions.map((version) => `${version.id}@${version.percentage}`),
              "--name",
              name,
              "--yes",
            ],
            lifetime: "started-write",
          });
          return yield* current(name);
        }
        return yield* createDeployment(json, { url: url(name), token: env.token, versions });
      }),
  };
};

const soleStableVersion = (deployment: Deployment): string => {
  if (deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100) {
    throw Error("Production Worker is not fully stable");
  }
  return deployment.versions[0].id;
};
const readStablePair = Effect.fn(function* ({
  port,
  workers,
  proof,
  client,
}: {
  port: ReleasePort;
  workers: WorkerReceipts;
  proof: string;
  client: HttpClient.HttpClient;
}) {
  const { publicDeployment, coreDeployment } = yield* Effect.all(
    {
      publicDeployment: port.current(workers.public.workerName),
      coreDeployment: port.current(workers.core.workerName),
    },
    { concurrency: 2 }
  ).pipe(
    Effect.mapError(
      () =>
        new ReleaseFailure({
          message: "Release capture could not read stable Worker deployments",
        })
    )
  );
  const publicStable = yield* Effect.try({
    try: () => soleStableVersion(publicDeployment),
    catch: () => new ReleaseFailure({ message: "Unstable public Worker" }),
  });
  const coreStable = yield* Effect.try({
    try: () => soleStableVersion(coreDeployment),
    catch: () => new ReleaseFailure({ message: "Unstable Core Worker" }),
  });
  const identity = yield* stableIdentity({
    publicVersionId: publicStable,
    coreVersionId: coreStable,
    proof,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.mapError(
      () =>
        new ReleaseFailure({ message: "Release capture could not verify the stable Worker pair" })
    )
  );
  return { publicStable, coreStable, identity };
});

const capture = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const workers = yield* workersFromState("capture");
  // The pinned Alchemy provider falls back to a direct 100% PUT when its previous Worker
  // output has no hash. Never let that branch masquerade as a candidate upload.
  if (!workers.public.hasRolloutBaseline || !workers.core.hasRolloutBaseline) {
    return yield* new ReleaseFailure({
      message: "Release capture blocked: Alchemy Worker rollout baseline is unavailable",
    });
  }
  const stablePair = yield* readStablePair({
    port,
    workers,
    proof: env.smokeProof,
    client,
  });
  const snapshot = yield* releaseController
    .captureRelease(port, {
      revision: env.revision,
      ...stablePair.identity,
      publicName: workers.public.workerName,
      coreName: workers.core.workerName,
    })
    .pipe(
      Effect.mapError(
        () => new ReleaseFailure({ message: "Release capture could not create a stable snapshot" })
      )
    );
  if (
    snapshot.public.stableVersionId !== stablePair.publicStable ||
    snapshot.core.stableVersionId !== stablePair.coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Stable Worker deployments changed during capture",
    });
  }
  yield* writeFile(env.file, encodeJson(snapshot));
});
const stage = Effect.fn(function* (port: ReleasePort, env: Config, client: HttpClient.HttpClient) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== snapshot.public.name ||
    workers.core.workerName !== snapshot.core.name ||
    Option.isNone(workers.public.versionId) ||
    Option.isNone(workers.core.versionId)
  ) {
    return yield* Effect.fail(Error("Alchemy candidate receipts are incomplete"));
  }
  yield* redactReleaseQueries(env, [snapshot.public.name, snapshot.core.name], client);
  const result = yield* releaseController.stageRelease(port, snapshot, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
  yield* writeFile(env.file, encodeJson(result));
});

/** Restricted to the inspected incident; ordinary releases cannot select this recovery path. */
const isolate = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  if (
    snapshot.public.stableVersionId !== "047a8004-15bd-4959-b064-0f020a529089" ||
    snapshot.core.stableVersionId !== "fa578c5f-2e94-4507-ba70-1fe4fe4dd150"
  ) {
    return yield* new ReleaseFailure({
      message: "Isolation refused: inspected incident baseline changed",
    });
  }
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== snapshot.public.name ||
    workers.core.workerName !== snapshot.core.name ||
    Option.isNone(workers.public.versionId) ||
    Option.isNone(workers.core.versionId)
  ) {
    return yield* new ReleaseFailure({ message: "Isolation candidate receipts are incomplete" });
  }
  const candidate = {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  };
  yield* Effect.all(
    [
      verifyIsolationCandidate(env, client, {
        name: snapshot.public.name,
        version: candidate.publicVersionId,
      }),
      verifyIsolationCandidate(env, client, {
        name: snapshot.core.name,
        version: candidate.coreVersionId,
      }),
    ],
    { concurrency: 2 }
  );
  yield* proveRecoveryCorePrivate(env, client, snapshot.core.name);
  const result = yield* releaseController.isolateRelease(port, snapshot, {
    candidate,
    proveIsolation: (version) =>
      proveRecoveryIsolation(client, env.smokeProof, version).pipe(
        Effect.andThen(proveRecoveryCorePrivate(env, client, snapshot.core.name))
      ),
  });
  yield* writeFile(env.file, encodeJson({ snapshot, ...result }));
});

const IsolationVersion = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: VersionId,
    resources: Schema.Struct({
      bindings: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.String,
          text: Schema.optional(Schema.String),
        })
      ),
    }),
  }),
});
const verifyIsolationCandidate = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  worker: { name: string; version: string }
) {
  const { name, version } = worker;
  const raw = yield* providerJson(
    HttpClientRequest.get(
      `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/versions/${version}`,
      { headers: { authorization: `Bearer ${env.token}` } }
    )
  ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const candidate = yield* Schema.decodeUnknownEffect(IsolationVersion)(raw);
  if (
    candidate.result.id !== version ||
    !candidate.result.resources.bindings.some(
      (binding) =>
        binding.name === "RECOVERY_ISOLATION" &&
        binding.type === "plain_text" &&
        binding.text === "isolated"
    )
  ) {
    return yield* new ReleaseFailure({ message: "Candidate does not enforce recovery isolation" });
  }
});

const proveRecoveryIsolation = Effect.fn(
  function* (client: HttpClient.HttpClient, proof: string, version: string) {
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/web/providers/disclosure`, {
        headers: { "x-fidy-smoke-proof": proof },
      })
    );
    if (
      response.status !== recoveryUnavailableStatus ||
      response.headers["x-fidy-recovery-isolation"] !== "isolated" ||
      response.headers["x-fidy-smoke-worker-version"] !== version
    ) {
      return yield* new ReleaseFailure({
        message: "Public recovery isolation not confirmed; Core unchanged",
      });
    }
  },
  Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 6 })
);

/** Read every public route on the inspected zone and account, including workers.dev previews. */
const proveRecoveryCorePrivate = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  name: string
) {
  const account = `https://api.cloudflare.com/client/v4/accounts/${env.account}`;
  const headers = { authorization: `Bearer ${env.token}` };
  const raw = yield* Effect.all(
    {
      subdomain: providerJson(
        HttpClientRequest.get(`${account}/workers/scripts/${encodeURIComponent(name)}/subdomain`, {
          headers,
        })
      ),
      domains: providerJson(HttpClientRequest.get(`${account}/workers/domains`, { headers })),
      routes: providerJson(
        HttpClientRequest.get(
          "https://api.cloudflare.com/client/v4/zones/d94aec07ff939334b56ab53931609e58/workers/routes",
          { headers }
        )
      ),
    },
    { concurrency: 3 }
  ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Struct({
        enabled: Schema.Literal(false),
        previews_enabled: Schema.Literal(false),
      }),
    })
  )(raw.subdomain);
  const domains = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(Schema.Struct({ service: Schema.String })),
    })
  )(raw.domains);
  const routes = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(
        Schema.Struct({ script: Schema.optional(Schema.NullOr(Schema.String)) })
      ),
    })
  )(raw.routes);
  if (
    domains.result.some((domain) => domain.service === name) ||
    routes.result.some((route) => route.script === name)
  ) {
    return yield* new ReleaseFailure({ message: "Recovery refused: Core is publicly reachable" });
  }
});
const stablePairUnchanged = Effect.fn(function* (port: ReleasePort, snapshot: ReleaseSnapshot) {
  const publicDeployment = yield* port.current(snapshot.public.name);
  const coreDeployment = yield* port.current(snapshot.core.name);
  return (
    soleStableVersion(publicDeployment) === snapshot.public.stableVersionId &&
    soleStableVersion(coreDeployment) === snapshot.core.stableVersionId
  );
});
const cleanup = Effect.fn(function* (port: ReleasePort, env: Config) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(env.file).exists(),
    catch: () => new ReleaseFailure({ message: "Release snapshot unavailable" }),
  });
  if (!exists) return;
  const raw = yield* readFile(env.file);
  const snapshot = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const original = Option.isSome(snapshot)
    ? (yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(raw)).snapshot
    : yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(raw);
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== original.public.name ||
    workers.core.workerName !== original.core.name
  ) {
    return yield* Effect.fail(Error("Worker identity changed during cleanup"));
  }
  if (Option.isNone(workers.public.versionId) || Option.isNone(workers.core.versionId)) {
    if (yield* stablePairUnchanged(port, original)) return;
    return yield* Effect.fail(Error("Candidate identity unavailable for guarded cleanup"));
  }
  yield* releaseCleanup.cleanRelease(port, original, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
});
const inspectTraffic = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const workers = yield* workersFromState("capture");
  const deployments = Effect.fn(function* (name: string) {
    const raw = yield* providerJson(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`,
        { headers: { authorization: `Bearer ${env.token}` } }
      )
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    const response = yield* Schema.decodeUnknownEffect(ListResponse)(raw);
    return response.result.deployments.slice(0, inspectionHistoryLimit).map(asDeployment);
  });
  const observed = {
    public: yield* deployments(workers.public.workerName),
    core: yield* deployments(workers.core.workerName),
  };
  yield* writeFile(Bun.stdout, `${encodeJson(observed)}\n`);
});
const reportTraffic = Effect.fn(function* (port: ReleasePort, env: Config) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(env.file).exists(),
    catch: () => new ReleaseFailure({ message: "Release snapshot unavailable" }),
  });
  if (!exists) {
    const promotedExists = yield* Effect.tryPromise({
      try: () => Bun.file(`${env.file}.promoted`).exists(),
      catch: () => new ReleaseFailure({ message: "Release receipt unavailable" }),
    });
    if (!promotedExists) {
      yield* writeFile(Bun.stdout, "Worker traffic unavailable: no release snapshot\n");
      return;
    }
  }
  const raw = exists
    ? yield* readFile(env.file)
    : (yield* Schema.decodeUnknownEffect(RollbackReceipt)(yield* readFile(`${env.file}.promoted`)))
        .release;
  const isStaged = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const snapshot = Option.isSome(isStaged)
    ? (yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(raw)).snapshot
    : yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(raw);
  const describe = (name: string): Effect.Effect<Deployment | { readonly status: "unavailable" }> =>
    port.current(name).pipe(Effect.orElseSucceed(() => ({ status: "unavailable" }) as const));
  const observed = {
    public: yield* describe(snapshot.public.name),
    core: yield* describe(snapshot.core.name),
  };
  yield* writeFile(Bun.stdout, `${encodeJson(observed)}\n`);
});
const promote = Effect.fn(function* (port: ReleasePort, env: Config) {
  const staged = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );
  const attestationRaw = yield* readFile(env.smokeAttestationFile);
  const attestation = yield* Schema.decodeUnknownEffect(SmokeAttestation)(attestationRaw);
  if (
    attestation.revision !== staged.snapshot.revision ||
    attestation.publicVersionId !== staged.publicVersionId ||
    attestation.coreVersionId !== staged.coreVersionId
  ) {
    return yield* Effect.fail(Error("Smoke attestation does not match candidate uploads"));
  }
  const promoted = yield* releaseController.promoteRelease(port, staged, {
    exactPairPassed: true,
    middlePairPassed: true,
  });
  // A successful promotion must retain the exact deployment IDs for guarded recovery.
  yield* writeFile(`${env.file}.promoted`, encodeJson({ release: staged, promoted }));
});

const versionResources = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  worker: { name: string; id: string }
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(worker.name)}/versions/${worker.id}`;
  const raw = yield* providerJson(
    HttpClientRequest.get(url, {
      headers: { authorization: `Bearer ${env.token}` },
    })
  ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const version = yield* Schema.decodeUnknownEffect(VersionResponse)(raw);
  if (version.result.id !== worker.id) {
    return yield* Effect.fail(Error("Worker version identity changed"));
  }
  return {
    bindings: version.result.resources.bindings,
    migrationTag: version.result.resources.script_runtime.migration_tag ?? "",
    exports: version.result.resources.script_runtime.exports,
  } satisfies WorkerResources;
});
const rollbackSource = Effect.fn(function* (snapshot: typeof releaseSchemas.snapshot.Type) {
  // A code-only release is the only automatic rollback case. A missing Git ancestor refuses.
  yield* shell([
    "git",
    "-C",
    "../..",
    "merge-base",
    "--is-ancestor",
    snapshot.stableRevision,
    snapshot.revision,
  ]);
  const changedPaths = (yield* shell([
    "git",
    "-C",
    "../..",
    "diff",
    "--name-only",
    snapshot.stableRevision,
    snapshot.revision,
    "--",
    "infra/cloudflare/alchemy.run.ts",
    "apps/server/cloudflare/",
  ]))
    .trim()
    .split("\n");
  const workflowPaths = new Set<string>();
  for (const revision of [snapshot.stableRevision, snapshot.revision]) {
    const found = yield* shell([
      "git",
      "-C",
      "../..",
      "grep",
      "-l",
      "-F",
      "WorkflowEntrypoint",
      revision,
      "--",
      "apps/server/cloudflare/",
    ]);
    for (const line of found.trim().split("\n")) {
      workflowPaths.add(line.slice(line.indexOf(":") + 1));
    }
  }
  return { changedPaths, workflowPaths: [...workflowPaths] };
});
const rollbackCompatibility = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: typeof RollbackReceipt.Type.release
) {
  const source = yield* rollbackSource(release.snapshot);
  const pairs = [
    {
      name: release.snapshot.public.name,
      stable: release.snapshot.public.stableVersionId,
      candidate: release.publicVersionId,
    },
    {
      name: release.snapshot.core.name,
      stable: release.snapshot.core.stableVersionId,
      candidate: release.coreVersionId,
    },
  ];
  let compatible = true;
  for (const pair of pairs) {
    const stable = yield* versionResources(env, client, { name: pair.name, id: pair.stable });
    const candidate = yield* versionResources(env, client, { name: pair.name, id: pair.candidate });
    compatible &&= rollbackCompatible({
      stable,
      candidate,
      ...source,
    });
  }
  return compatible;
});
const rollback = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const { release, promoted } = yield* Schema.decodeUnknownEffect(RollbackReceipt)(
    yield* readFile(`${env.file}.promoted`)
  );
  const compatible = yield* rollbackCompatibility(env, client, release);
  const guarded: RollbackPort = {
    ...port,
    deployable: (name, id) =>
      Effect.gen(function* () {
        const versions = yield* Schema.decodeUnknownEffect(DeployableResponse)(
          yield* providerJson(
            HttpClientRequest.get(
              `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/versions?deployable=true`,
              { headers: { authorization: `Bearer ${env.token}` } }
            )
          ).pipe(Effect.provideService(HttpClient.HttpClient, client))
        );
        return versions.result.items.some((item) => item.id === id);
      }),
  };
  yield* releaseRollback.restore(guarded, { release, promoted, compatible });
});

const verifyRetirement = Effect.fn(function* (port: ReleasePort, env: Config) {
  const receipt = yield* Schema.decodeUnknownEffect(RollbackReceipt)(
    yield* readFile(`${env.file}.promoted`)
  );
  if (receipt.release.snapshot.revision !== env.revision) {
    return yield* Effect.fail(Error("Retirement receipt does not belong to this release"));
  }
  yield* releaseController.verifyRetirement(port, receipt);
});

const runRouting = Effect.fn(function* ({
  command,
  port,
  env,
  client,
}: {
  command: "capture" | "stage" | "promote" | "rollback" | "cleanup" | "report" | "inspect";
  port: ReleasePort;
  env: Config;
  client: HttpClient.HttpClient;
}) {
  switch (command) {
    case "capture":
      yield* capture(port, env, client);
      break;
    case "stage":
      yield* stage(port, env, client);
      break;
    case "promote":
      yield* promote(port, env);
      break;
    case "rollback":
      yield* rollback(port, env, client);
      break;
    case "cleanup":
      yield* cleanup(port, env);
      break;
    case "report":
      yield* reportTraffic(port, env);
      break;
    case "inspect":
      yield* inspectTraffic(env, client);
      break;
  }
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(Commands)(process.argv[2]);
    const environment = config();
    const services = yield* Layer.build(FetchHttpClient.layer);
    const client = Context.get(services, HttpClient.HttpClient);
    const port = releasePort({ env: environment, client });
    if (command === "verify-retirement") {
      yield* verifyRetirement(port, environment);
    } else if (command === "isolate") {
      yield* isolate(port, environment, client);
    } else {
      yield* runRouting({ command, port, env: environment, client });
    }
    yield* writeFile(Bun.stdout, "Production release routing step passed.\n");
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(`${releaseFailureMessage(cause)}\n`);
          process.exitCode = 1;
        })
      )
    )
  );
}
