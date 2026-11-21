import uploadedPair from "./native-pairing-upload.json" with { type: "json" };
import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import { stagedAccountingRevision } from "./native-fixture-signer";
import { archivedDormant } from "./native-fallback-recovery";
import { CategoryTaxonomyRelease } from "../../apps/server/src/core/categories/contract";
import { compatibleCategoryReleases } from "../../apps/server/src/core/categories/operations";

import { verifyStableWorkerIdentity } from "./stable-worker-identity";
import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";
import { isReleaseSmokeFailed } from "./smoke-exchange";
import { isDeepStrictEqual } from "node:util";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { freeTierWorkerObservability } from "./worker-observability";
import { type RollbackPort } from "./release-rollback";
import { verifiedVersionResources } from "./rollback-compatibility";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  type StableRestoration,
  releaseController,
  type releaseSchemas,
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

const CreateResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: ApiDeployment,
});

const DeployableResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: VersionId })),
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

const ResourceAttributes = Schema.Record(Schema.String, Schema.Unknown);

const WorkerIdentity = Schema.Struct({ workerName: WorkerName });

const StateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literals(["created", "updated", "replaced"]),
  attr: ResourceAttributes,
});

const UpdatingStateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literal("updating"),
  attr: ResourceAttributes,
  old: Schema.Struct({ attr: ResourceAttributes }),
});

const StateMap = Schema.Record(Schema.String, Schema.Unknown);

const healthSchema = Schema.Struct({
  status: Schema.Literal("available"),
  gitRevision: SmokeIdentity.fields.gitRevision,
  contractDigest: SmokeIdentity.fields.contractDigest,
});

const responseLimit = 100_000;

const successStatusStart = 200;

const successStatusEnd = 300;

const isSuccessStatus = (status: number): boolean =>
  status >= successStatusStart && status < successStatusEnd;

const DeploymentRejection = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      code: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
      ),
    })
  ),
});

const badRequest = 400;

const modifiedSecretsCode = 10220;

const ModifiedSecretsRejection = Schema.is(
  Schema.Struct({
    success: Schema.Literal(false),
    errors: Schema.Tuple([Schema.Struct({ code: Schema.Literal(modifiedSecretsCode) })]),
  })
);

class ModifiedDeploymentSecrets extends Data.TaggedError("ModifiedDeploymentSecrets") {}

export class ReleaseFailure extends Data.TaggedError("ReleaseFailure")<{ message: string }> {}

export class CausedReleaseFailure extends ReleaseFailure {
  constructor(args: Readonly<{ message: string; cause: unknown }>) {
    super(args);
  }
}

export const releaseFailureFrom =
  (message: string) =>
  (cause: unknown): ReleaseFailure =>
    new CausedReleaseFailure({ message, cause });

export const isReleaseFailure = (value: unknown): value is ReleaseFailure =>
  Predicate.isTagged(value, "ReleaseFailure");

const isModifiedDeploymentSecrets = (value: unknown): value is ModifiedDeploymentSecrets =>
  Predicate.isTagged(value, "ModifiedDeploymentSecrets");

export const releaseFailureMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isReleaseFailure(reason.error)) {
      return reason.error.message;
    }

    if (Cause.isFailReason(reason) && isModifiedDeploymentSecrets(reason.error)) {
      return `Cloudflare deployment rejected (HTTP ${badRequest}; code ${modifiedSecretsCode})`;
    }
  }

  return "Production release routing failed; inspect Worker deployment state before recovery.";
};

const Json = Schema.fromJsonString(Schema.Unknown);

const decodeJson = Schema.decodeUnknownEffect(Json);

const encodeJson = Schema.encodeSync(Json);

export type ProductionReleaseConfig = Readonly<{
  account: string;
  token: string;
  revision: string;
  repository: string;
  githubToken: string;
  file: string;
  smokeProof: string;
  smokeAttestationFile: string;
}>;

type Config = ProductionReleaseConfig;

const verifiedSource = (operation: string, sealed?: string): string =>
  operation === "resume-pairing-stage"
    ? uploadedPair.revision
    : (sealed ?? archivedDormant.revision);

const interruptedSuccessor = "de04a192c3836be0efb488b170a7b93b9f98f28f";

const successorWorkflow =
  "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk";

const FixtureVerifierEnvironment = Schema.Struct({
  FIXTURE_STAGED_VERIFIER_SHA: SmokeIdentity.fields.gitRevision,
  GITHUB_SHA: SmokeIdentity.fields.gitRevision,
  RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
  GITHUB_ACTIONS: Schema.Literal("true"),
  GITHUB_REPOSITORY: Schema.Literal("B4rz99/fidy-ai"),
  GITHUB_EVENT_NAME: Schema.Literal("workflow_dispatch"),
  GITHUB_REF: Schema.Literal("refs/heads/trunk"),
  GITHUB_REF_PROTECTED: Schema.Literal("true"),
  NATIVE_STORAGE_ADMISSION: Schema.Literal("closed"),
  NATIVE_STORAGE_HOSTS: Schema.Literal("acceptance"),
  FIXTURE_RELEASE_OPERATION: Schema.Literals([
    "stage-fixture-successor",
    "recover-fixture-successor",
    "rollout-fixture-successor",
    "resume-pairing-stage",
    "reseal-fixture-fallback",
    "diagnose-fixture-pairing",
    "recover-fixture-fallback",
    "resume-pairing-rollback",
    "rollout",
    "verify",
  ]),
});

type FixtureVerifierEnvironment = typeof FixtureVerifierEnvironment.Type;

const resumedSuccessorOperations = new Set<string>([
  "stage-fixture-successor",
  "recover-fixture-successor",
  "rollout-fixture-successor",
]);

const matchesResumedSuccessor = (
  selected: FixtureVerifierEnvironment,
  environment: typeof process.env
): boolean =>
  selected.RELEASE_GIT_SHA === interruptedSuccessor &&
  resumedSuccessorOperations.has(selected.FIXTURE_RELEASE_OPERATION) &&
  environment.FIXTURE_PAIRING_APPLICATION === undefined &&
  environment.GITHUB_WORKFLOW_REF === successorWorkflow &&
  environment.GITHUB_RUN_ATTEMPT === "1";

const matchesFixtureSource = (selected: FixtureVerifierEnvironment, sealed?: string): boolean =>
  !resumedSuccessorOperations.has(selected.FIXTURE_RELEASE_OPERATION) &&
  selected.RELEASE_GIT_SHA === verifiedSource(selected.FIXTURE_RELEASE_OPERATION, sealed) &&
  (sealed === undefined ||
    ["recover-fixture-fallback", "resume-pairing-rollback", "rollout", "verify"].includes(
      selected.FIXTURE_RELEASE_OPERATION
    ));

const matchesAccountingContinuation = (
  selected: FixtureVerifierEnvironment,
  environment: typeof process.env
): boolean =>
  selected.RELEASE_GIT_SHA === stagedAccountingRevision &&
  selected.FIXTURE_RELEASE_OPERATION === "rollout-fixture-successor" &&
  environment.FIXTURE_ACCOUNTING_ROLLOUT === "true" &&
  environment.FIXTURE_SUCCESSOR_RESUME === "false" &&
  environment.GITHUB_WORKFLOW_REF === successorWorkflow &&
  environment.GITHUB_RUN_ATTEMPT === "1";

const matchesStagedFixture = (
  selected: FixtureVerifierEnvironment,
  environment: typeof process.env
): boolean => {
  if (environment.FIXTURE_ACCOUNTING_CONTINUATION === "true") {
    return matchesAccountingContinuation(selected, environment);
  }

  return environment.FIXTURE_SUCCESSOR_RESUME === "true"
    ? matchesResumedSuccessor(selected, environment)
    : matchesFixtureSource(selected, environment.FIXTURE_PAIRING_APPLICATION);
};

const fixtureVerifierIdentity = Effect.sync(() => {
  const environment = process.env;

  if (environment.FIXTURE_STAGED_VERIFIER_SHA === undefined) {
    return Option.none<{ application: string; verifier: string }>();
  }

  const result = Schema.decodeUnknownOption(FixtureVerifierEnvironment)(environment);

  if (
    Option.isNone(result) ||
    result.value.FIXTURE_STAGED_VERIFIER_SHA !== result.value.GITHUB_SHA ||
    !matchesStagedFixture(result.value, environment)
  ) {
    throw Error("Unverified staged application source");
  }

  return Option.some({
    application: result.value.RELEASE_GIT_SHA,
    verifier: result.value.GITHUB_SHA,
  });
});

export const fixtureVerifier = Effect.map(
  fixtureVerifierIdentity,
  Option.map((identity) => identity.verifier)
);

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

const deploymentRefusal = (status: number, text: string): Error => {
  const payload = Schema.decodeOption(Json)(text);

  if (status === badRequest && Option.exists(payload, ModifiedSecretsRejection)) {
    return new ModifiedDeploymentSecrets();
  }

  const rejection = Option.flatMap(payload, Schema.decodeUnknownOption(DeploymentRejection));
  const code = Option.flatMap(rejection, (value) => Option.fromNullishOr(value.errors[0]?.code));

  return new ReleaseFailure({
    message: `Cloudflare deployment rejected (HTTP ${status}${Option.match(code, {
      onNone: () => "",
      onSome: (value) => `; code ${value}`,
    })})`,
  });
};

const boundedJson = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  reportDeploymentRejection: boolean
) {
  const rejected = !isSuccessStatus(response.status);

  if (rejected && !reportDeploymentRejection) {
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

      if (value.byteLength > 0) chunks.push(value);

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

  const text = new TextDecoder().decode(bytes);

  return yield* rejected ? Effect.fail(deploymentRefusal(response.status, text)) : decodeJson(text);
});

export class WorkerVersionReadUnavailable extends Data.TaggedError("WorkerVersionReadUnavailable")<{
  status: number;
}> {}

export const isWorkerVersionReadUnavailable = (
  value: unknown
): value is WorkerVersionReadUnavailable =>
  Predicate.isTagged(value, "WorkerVersionReadUnavailable");

const notFound = 404,
  requestTimeout = 408,
  rateLimited = 429,
  serverError = 500,
  badGateway = 502,
  unavailable = 503,
  gatewayTimeout = 504;

const transientVersionRead = new Set([
  notFound,
  requestTimeout,
  rateLimited,
  serverError,
  badGateway,
  unavailable,
  gatewayTimeout,
]);

const providerJson = Effect.fn(
  function* (
    request: HttpClientRequest.HttpClientRequest,
    reportDeploymentRejection: boolean = false,
    immutableVersion: boolean = false
  ) {
    const client = yield* HttpClient.HttpClient;

    const response = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(Effect.mapError(() => Error("Provider request failed; inspect traffic state")));

    if (immutableVersion && request.method === "GET" && transientVersionRead.has(response.status)) {
      return yield* new WorkerVersionReadUnavailable({
        status: response.status,
      });
    }

    return yield* boundedJson(response, reportDeploymentRejection);
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
);

export const verifyCoreDefaultPlacement = Effect.fn(function* (
  env: Pick<Config, "account" | "token">,
  core: Readonly<{ name: string; version: string }>,
  client: HttpClient.HttpClient
) {
  const response = Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Struct({
      id: Schema.Literal(core.version),
      resources: Schema.Struct({
        script: Schema.Struct({
          placement: Schema.optionalKey(Schema.Never),
          placement_mode: Schema.optionalKey(Schema.Never),
        }),
      }),
    }),
  });

  yield* providerJson(
    HttpClientRequest.get(
      `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(core.name)}/versions/${encodeURIComponent(core.version)}`,
      { headers: { authorization: `Bearer ${env.token}` } }
    )
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.flatMap(Schema.decodeUnknownEffect(response)),
    Effect.mapError(
      (error) =>
        new CausedReleaseFailure({
          message: "Release staging refused: Core default placement is unverified",
          cause: error,
        })
    )
  );
});

const VerifiedObservability = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    observability: Schema.Struct({
      enabled: Schema.Literal(true),
      redact_query_string: Schema.Literal(true),
      issues: Schema.Struct({ enabled: Schema.Literal(true) }),
      logs: Schema.Struct({
        enabled: Schema.Literal(true),
        invocation_logs: Schema.Literal(false),
        persist: Schema.Literal(true),
      }),
    }),
  }),
});

export const verifyReleaseObservability = Effect.fn(function* (
  env: Pick<Config, "account" | "token">,
  name: string,
  client: HttpClient.HttpClient
) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}`,
    headers = { authorization: `Bearer ${env.token}` };

  yield* providerJson(HttpClientRequest.get(`${base}/settings`, { headers })).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.flatMap(Schema.decodeUnknownEffect(VerifiedObservability)),
    Effect.mapError(
      (error) =>
        new CausedReleaseFailure({
          message: "Release staging refused: private operational observability is unverified",
          cause: error,
        })
    )
  );
});

export const configureReleaseObservability = Effect.fn(function* (
  env: Pick<Config, "account" | "token">,
  names: ReadonlyArray<string>,
  client: HttpClient.HttpClient
) {
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const base = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}`;
        const headers = { authorization: `Bearer ${env.token}` };
        yield* providerJson(
          HttpClientRequest.patch(`${base}/script-settings`, {
            headers: { ...headers, "content-type": "application/json" },
            body: HttpBody.text(
              encodeJson({
                observability: {
                  enabled: freeTierWorkerObservability.enabled,
                  head_sampling_rate: freeTierWorkerObservability.headSamplingRate,
                  redact_query_string: freeTierWorkerObservability.redactQueryString,
                  issues: freeTierWorkerObservability.issues,
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
        yield* verifyReleaseObservability(env, name, client);
      }),
    { discard: true }
  );
});

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

      return Option.fromNullishOr(output.match(/\[code: (\d{4,6})\]/u)?.[1]).pipe(
        Option.orElse(() =>
          output.includes(
            "All versions in a percentage-split deployment must declare identical Durable Object `exports`."
          )
            ? Option.some("100405")
            : Option.none()
        ),
        Option.map((code) => {
          if (/\bqueues?\b/iu.test(output)) return `${code}; resource=queue`;

          if (/\bworkflows?\b/iu.test(output)) return `${code}; resource=workflow`;

          return code;
        })
      );
    });
};

const releaseCommandShutdownGrace = 2000;

const stopReadOnlyCommand = Effect.fn(function* (child: Bun.Subprocess) {
  if (child.exitCode !== null) return;
  yield* Effect.try({
    try: () => child.kill("SIGTERM"),
    catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
  });

  const exited = yield* Effect.tryPromise({
    try: () => child.exited,
    catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
  }).pipe(Effect.timeoutOption(releaseCommandShutdownGrace));

  if (Option.isNone(exited)) {
    yield* Effect.try({
      try: () => child.kill("SIGKILL"),
      catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
    });
    yield* Effect.tryPromise({
      try: () => child.exited,
      catch: () => new ReleaseFailure({ message: "Release tooling cleanup failed" }),
    });
  }
});

const releaseOutput = (
  stream: ReadableStream<Uint8Array>,
  overflow: () => Effect.Effect<void, ReleaseFailure>
): Effect.Effect<string, ReleaseFailure> =>
  Effect.gen(function* () {
    const limit = 1_048_576;
    const decoder = new TextDecoder();
    let size = 0;
    let retained = "";
    const outputState = { exceeded: false };
    yield* Stream.fromReadableStream({
      evaluate: () => stream,
      onError: () =>
        new ReleaseFailure({
          message: "Release tooling output could not be read",
        }),
      releaseLockOnEnd: true,
    }).pipe(
      Stream.runForEach((chunk) => {
        if (outputState.exceeded) return Effect.void;
        size += chunk.byteLength;

        if (size > limit) {
          outputState.exceeded = true;
          retained = "";

          return overflow();
        }

        retained += decoder.decode(chunk, { stream: true });

        return Effect.void;
      })
    );

    if (outputState.exceeded) {
      return yield* new ReleaseFailure({
        message: "Release tooling output exceeded limit",
      });
    }

    return retained + decoder.decode();
  });

const startReleaseCommand = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  lifetime: "read-only" | "started-write"
) {
  const child = yield* Effect.try({
    try: () =>
      Bun.spawn([...args], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      }),
    catch: (cause) => new CausedReleaseFailure({ message: "Release tooling failed", cause }),
  });

  const processSettlement = Promise.allSettled([child.exited, toolingRefusal(child.stderr)]);

  const output = yield* releaseOutput(child.stdout, () =>
    lifetime === "read-only" ? stopReadOnlyCommand(child) : Effect.void
  ).pipe(Effect.result, Effect.forkDetach);

  const settlement = Effect.all([
    Fiber.join(output),
    Effect.tryPromise({
      try: () => processSettlement,
      catch: (cause) => new CausedReleaseFailure({ message: "Release tooling failed", cause }),
    }),
  ]);

  return { child, settlement };
});

export const releaseCommand = ({
  args,
  lifetime,
}: Readonly<{
  args: ReadonlyArray<string>;
  lifetime: "read-only" | "started-write";
}>): Effect.Effect<string, ReleaseFailure> =>
  Effect.acquireUseRelease(
    startReleaseCommand(args, lifetime),
    ({ settlement }) =>
      settlement.pipe(
        Effect.flatMap(([output, [exit, code]]) =>
          Result.isSuccess(output) && exit.status === "fulfilled" && exit.value === 0
            ? Effect.succeed(output.success)
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
          lifetime === "read-only" && Exit.isFailure(exit) && child.exitCode === null
            ? stopReadOnlyCommand(child)
            : Effect.void
        );

        const [, [processExit]] = yield* settlement.pipe(
          Effect.mapError(
            (error) =>
              new CausedReleaseFailure({
                message: "Release tooling cleanup failed",
                cause: error,
              })
          )
        );

        if (Exit.isFailure(cancellation)) return yield* Effect.failCause(cancellation.cause);

        if (processExit.status !== "fulfilled") {
          return yield* new ReleaseFailure({
            message: "Release tooling exit could not be confirmed",
          });
        }
      })
  ).pipe(
    lifetime === "read-only" ? Effect.timeout("60 seconds") : (effect) => effect,
    Effect.mapError((error) =>
      Cause.isTimeoutError(error)
        ? new ReleaseFailure({
            message: "Release tooling exceeded deadline; inspect traffic state",
          })
        : error
    )
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
    } catch {}
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

export const decodePairingUploadReceipts = (output: string): WorkerReceipts => {
  const receipts = decodeWorkerReceipts(output);
  const logicalId = "ReleaseSmoke-" + fixtureUpload.revision;

  const entries = Object.values(decodeStateMap(output)).filter((value) =>
    Option.exists(
      Schema.decodeUnknownOption(ResourceIdentity)(value),
      (item) => item.logicalId === logicalId
    )
  );

  const support = Schema.decodeUnknownOption(
    Schema.Struct({
      logicalId: Schema.Literal(logicalId),
      status: StateEntry.fields.status,
      attr: Schema.Struct({
        workerName: Schema.Literal("fidy-native-smoke-" + fixtureUpload.revision),
        versionId: Schema.optionalKey(Schema.Literal(uploadedPair.smoke.versionId)),
      }),
    })
  )(entries[0]);

  if (
    entries.length !== 1 ||
    Option.isNone(support) ||
    !Option.contains(receipts.public.versionId, uploadedPair.publicVersionId) ||
    !Option.contains(receipts.core.versionId, uploadedPair.coreVersionId)
  ) {
    throw Error("Alchemy completed Worker versions differ from the interrupted pairing upload");
  }

  return receipts;
};

const workersFromState = Effect.fn(function* (
  mode: "capture" | "completed",
  stack: string,
  requirePairingUpload: boolean = false
) {
  const rawState = yield* shell([
    "bun",
    "../../node_modules/alchemy/bin/alchemy.js",
    "state",
    "read",
    "--backend",
    "cloudflare",
    "--recursive",
    stack + "/production",
    "--no-input",
    "--log-level",
    "error",
  ]);

  return yield* Effect.try({
    try: () => {
      if (requirePairingUpload) return decodePairingUploadReceipts(rawState);

      return mode === "capture"
        ? decodeCaptureWorkerReceipts(rawState)
        : decodeWorkerReceipts(rawState);
    },
    catch: (cause) =>
      new ReleaseFailure({
        message:
          Predicate.isError(cause) && safeWorkerReceiptMessages.has(cause.message)
            ? cause.message
            : "Alchemy Worker state JSON could not be decoded",
      }),
  });
});

const stableIdentity = Effect.fn(function* (
  input: {
    publicVersionId: string;
    coreVersionId: string;
    proof: string;
  },
  releaseOrigin: string
) {
  const health = yield* Schema.decodeUnknownEffect(healthSchema)(
    yield* providerJson(HttpClientRequest.get(`${releaseOrigin}/health`))
  );

  yield* verifyStableWorkerIdentity(
    {
      public: { ...health, workerVersionId: input.publicVersionId },
      core: { ...health, workerVersionId: input.coreVersionId },
      proof: input.proof,
    },
    releaseOrigin
  );

  return {
    stableRevision: health.gitRevision,
    stableContractDigest: health.contractDigest,
  };
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
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
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

const deploymentUrl = (env: Config, name: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`;

const readTrunk = Effect.fn(function* (env: Config) {
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

  const verifier = yield* fixtureVerifierIdentity;

  if (Option.isNone(verifier)) return response.object.sha;

  if (
    response.object.sha !== verifier.value.verifier ||
    env.revision !== verifier.value.application
  ) {
    return yield* new ReleaseFailure({
      message: "Current protected verifier differs from the qualified staged release",
    });
  }

  return env.revision;
});

export const releasePort = ({
  env,
  client,
}: {
  env: Config;
  client: HttpClient.HttpClient;
}): ReleasePort & {
  recentDeployments(name: string): Effect.Effect<readonly Deployment[], Error>;
} => {
  const json = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<unknown, Error> =>
    providerJson(request, request.method === "POST").pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    );

  const recentDeployments = Effect.fn(function* (name: string) {
    const raw = yield* json(
      HttpClientRequest.get(deploymentUrl(env, name), {
        headers: { authorization: `Bearer ${env.token}` },
      })
    );

    const response = yield* Schema.decodeUnknownEffect(ListResponse)(raw);

    return response.result.deployments.map(asDeployment);
  });

  const current: ReleasePort["current"] = Effect.fn(function* (name) {
    const [active] = yield* recentDeployments(name);

    if (active === undefined) return yield* Effect.fail(Error(`No active deployment: ${name}`));

    return active;
  });

  return {
    trunk: () => readTrunk(env).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    current,
    recentDeployments,
    deploy: (name, versions) =>
      Effect.gen(function* () {
        if (versions.some((version) => version.percentage === 0)) {
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

        return yield* createDeployment(json, {
          url: deploymentUrl(env, name),
          token: env.token,
          versions,
        });
      }),
  };
};

const readStablePair = Effect.fn(function* (
  {
    port,
    workers,
    proof,
    client,
  }: {
    port: ReleasePort;
    workers: WorkerReceipts;
    proof: string;
    client: HttpClient.HttpClient;
  },
  releaseOrigin: string
) {
  const { publicDeployment, coreDeployment } = yield* Effect.all(
    {
      publicDeployment: port.current(workers.public.workerName),
      coreDeployment: port.current(workers.core.workerName),
    },
    { concurrency: 2 }
  ).pipe(
    Effect.mapError(
      (error) =>
        new CausedReleaseFailure({
          message: "Release capture could not read stable Worker deployments",
          cause: error,
        })
    )
  );

  const publicStable = yield* releaseController
    .servingVersion(publicDeployment)
    .pipe(Effect.mapError(releaseFailureFrom("Unstable public Worker")));

  const coreStable = yield* releaseController
    .servingVersion(coreDeployment)
    .pipe(Effect.mapError(releaseFailureFrom("Unstable Core Worker")));

  const identity = yield* stableIdentity(
    {
      publicVersionId: publicStable,
      coreVersionId: coreStable,
      proof,
    },
    releaseOrigin
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.mapError(
      (failure) =>
        new ReleaseFailure({
          message: isReleaseSmokeFailed(failure)
            ? `Stable Worker capture rejected: ${failure.reason}`
            : "Release capture could not verify the stable Worker pair",
        })
    )
  );

  return { publicStable, coreStable, identity };
});

const readCategoryRelease = Effect.fn(function* (revision: string) {
  const source = yield* shell([
    "git",
    "-C",
    "../..",
    "show",
    revision + ":apps/server/src/core/categories/internal/taxonomy-release.json",
  ]);

  return yield* Schema.decodeEffect(Schema.fromJsonString(CategoryTaxonomyRelease))(source);
});

const verifyTaxonomyOverlap = Effect.fn(function* (
  snapshot: Readonly<{ stableRevision: string; revision: string }>
) {
  const serving = yield* readCategoryRelease(snapshot.stableRevision);
  const candidate = yield* readCategoryRelease(snapshot.revision);

  if (!compatibleCategoryReleases({ serving, candidate })) {
    return yield* new ReleaseFailure({
      message:
        "Taxonomy overlap is incompatible. Ship reader support before enabling the writing revision.",
    });
  }
});

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
        Schema.Struct({
          script: Schema.optional(Schema.NullOr(Schema.String)),
        })
      ),
    })
  )(raw.routes);

  if (
    domains.result.some((domain) => domain.service === name) ||
    routes.result.some((route) => route.script === name)
  ) {
    return yield* new ReleaseFailure({
      message: "Recovery refused: Core is publicly reachable",
    });
  }
});

const readWorkerVersion = Effect.fn(function* (
  env: Pick<Config, "account" | "token">,
  client: HttpClient.HttpClient,
  worker: { name: string; id: string }
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(worker.name)}/versions/${worker.id}`;

  return yield* providerJson(
    HttpClientRequest.get(url, {
      headers: { authorization: `Bearer ${env.token}` },
    }),
    false,
    true
  ).pipe(Effect.provideService(HttpClient.HttpClient, client));
});

const versionResources = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  worker: { name: string; id: string; revision: string }
) {
  const raw = yield* readWorkerVersion(env, client, worker);

  return yield* Effect.try(() =>
    verifiedVersionResources({
      raw,
      versionId: worker.id,
      revision: worker.revision,
    })
  );
});

const rollbackSource = Effect.fn(function* (snapshot: typeof releaseSchemas.snapshot.Type) {
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
    "infra/cloudflare/alchemy.storage.ts",
    "infra/cloudflare/storage-installation.ts",
    "apps/server/cloudflare/",
  ]))
    .trim()
    .split("\n");

  const workflowPaths = new Set<string>();

  const foundByRevision = yield* Effect.forEach(
    [snapshot.stableRevision, snapshot.revision],
    (revision) =>
      shell([
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
      ])
  );

  for (const found of foundByRevision) {
    for (const line of found.trim().split("\n")) {
      workflowPaths.add(line.slice(line.indexOf(":") + 1));
    }
  }

  const reviewedAccountingVerifier =
    snapshot.stableRevision === interruptedSuccessor &&
    snapshot.revision === stagedAccountingRevision;

  return {
    changedPaths: reviewedAccountingVerifier
      ? changedPaths.filter((path) => path !== "infra/cloudflare/storage-installation.ts")
      : changedPaths,
    workflowPaths: [...workflowPaths],
  };
});

const rollbackPort = (
  port: ReturnType<typeof releasePort>,
  env: Config,
  client: HttpClient.HttpClient
): RollbackPort => ({
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
});

type CanonicalRestoration = Readonly<{
  port: RollbackPort;
  env: Config;
  client: HttpClient.HttpClient;
  snapshot: ReleaseSnapshot;
  verifyClosedPair: Effect.Effect<void, Error>;
}>;

const requireRestorationHistory = Effect.fn(function* (
  port: RollbackPort,
  { name, previous }: StableRestoration["companion"]
) {
  const history = yield* port.recentDeployments(name);
  const current = history.at(0);

  const sameVersions =
    current !== undefined &&
    current.versions.length === previous.versions.length &&
    previous.versions.every((version) =>
      current.versions.some(
        (actual) => actual.id === version.id && actual.percentage === version.percentage
      )
    );

  if (current?.id !== previous.id || !sameVersions) {
    return yield* Effect.fail(Error("Canonical restoration requires the proved live pair"));
  }

  return history;
});

const readCanonicalRestorationHistory = Effect.fn(function* (
  { port, snapshot }: CanonicalRestoration,
  { target, companion }: StableRestoration
) {
  const histories = yield* Effect.forEach([target, companion], (worker) =>
    requireRestorationHistory(port, worker)
  );

  yield* releaseController.requireTrunk(port, snapshot.revision);

  return histories;
});

const retryClosedRestoration = Effect.fn(function* (
  config: CanonicalRestoration,
  input: StableRestoration,
  before: readonly (readonly Deployment[])[]
) {
  const { port, env, client, verifyClosedPair } = config;
  const { target } = input;
  yield* verifyClosedPair;

  if (!(yield* port.deployable(target.name, target.stableVersionId))) {
    return yield* Effect.fail(Error("Captured closed Worker is no longer deployable"));
  }

  const after = yield* readCanonicalRestorationHistory(config, input);

  if (!isDeepStrictEqual(before, after)) {
    return yield* Effect.fail(Error("Canonical restoration history changed after refusal"));
  }

  return yield* createDeployment(
    (request) =>
      providerJson(request, true).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    {
      url: deploymentUrl(env, target.name) + "?force=true",
      token: env.token,
      versions: [{ id: target.stableVersionId, percentage: 100 }],
    }
  );
});

const restoreCanonicalStable = Effect.fn(function* (
  config: CanonicalRestoration,
  input: StableRestoration
) {
  const { port, snapshot } = config;
  const { target, companion } = input;
  const workers = [snapshot.public, snapshot.core];
  const captured = workers.find((worker) => worker.name === target.name);

  if (
    captured?.stableVersionId !== target.stableVersionId ||
    !workers.some((worker) => worker.name === companion.name && worker.name !== target.name)
  ) {
    return yield* Effect.fail(
      Error("Canonical restoration target differs from the closed capture")
    );
  }

  const before = yield* readCanonicalRestorationHistory(config, input);

  return yield* port.deploy(target.name, [{ id: captured.stableVersionId, percentage: 100 }]).pipe(
    Effect.catchIf(
      (error) => isModifiedDeploymentSecrets(error),
      () => retryClosedRestoration(config, input, before)
    )
  );
});

export const canonicalRestorePort = (config: CanonicalRestoration): RollbackPort => ({
  ...config.port,
  restoreStable: (input) => restoreCanonicalStable(config, input),
});

export const releaseEvidence = {
  config,
  encodeJson,
  readFile,
  writeFile,
  workersFromState,
  readStablePair,
  proveRecoveryCorePrivate,
  versionResources,
  readWorkerVersion,
  rollbackSource,
  verifyTaxonomyOverlap,
  providerJson,
  rollbackPort,
};
