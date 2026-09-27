import { readFile, stat } from "node:fs/promises";
import { Data, Effect, Option, Schema } from "effect";
import { heapUsage, inspectorTarget, profileWorkerRequest } from "./workerd-inspector";

const kibibyte = Number("1024");
const microsecondsPerMillisecond = Number("1000");
const readinessAttempts = Number("80");
const readinessRetryMilliseconds = Number("100");
const serverPort = 8795;
const inspectorPort = 9294;
const truncatedImageHeaderBytes = Number("24");
const unprocessableContentStatus = Number("422");
const payloadTooLargeStatus = Number("413");
const connectionUpperBound = Number("1");
const conversionAttempts = Number("3");
const workerdProbes = [
  "unknown-bytes",
  "truncated-pdf",
  "oversized-image-dimensions",
  "malformed-image-provider-rejection",
  "protected-pdf-password",
] as const;

const StartupProfile = Schema.Struct({ endTime: Schema.Finite, startTime: Schema.Finite });
const ConvertedResult = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  outcome: Schema.Literal("converted"),
  outputBytes: Schema.Int,
});
const RejectedResult = Schema.Struct({
  outcome: Schema.Literal("rejected"),
  reason: Schema.String,
});

type ProofOptions = {
  readonly configPath: string;
  readonly infrastructureRoot: string;
  readonly maximumBundleBytes: number;
  readonly maximumMemoryBytes: number;
  readonly maximumStartupMilliseconds: number;
  readonly runAuthenticatedRuntime: boolean;
  readonly temporaryDirectory: string;
  readonly wranglerPath: string;
};

type RuntimeProof = {
  readonly imageCpuMilliseconds: number;
  readonly pdfCpuMilliseconds: number;
  readonly retainedHeapBytes: number;
  readonly retainedHeapGrowthBytes: number;
};

type BuiltProof = {
  readonly bundleBytes: number;
  readonly connectionUpperBound: number;
  readonly startupMilliseconds: number;
  readonly uploadBytes: number;
};

export type ExtractionProof = BuiltProof &
  (
    | (RuntimeProof & {
        readonly runtimeStatus: "authenticated";
        readonly workerdProbes: typeof workerdProbes;
      })
    | {
        readonly runtimeStatus: "credentials-required";
      }
  );

class ProofIoError extends Data.TaggedError("ProofIoError")<{ readonly cause: unknown }> {}

type ProofError = ProofIoError | Schema.SchemaError;

const fromPromise = <A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ProofIoError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new ProofIoError({ cause }) });

const runWrangler = (command: Array<string>, cwd: string): string => {
  const result = Bun.spawnSync(command, { cwd, stderr: "inherit", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Extraction proof command failed: ${command[1]}`);
  return new TextDecoder().decode(result.stdout);
};

const buildProof = (
  options: ProofOptions
): Effect.Effect<
  Pick<BuiltProof, "bundleBytes" | "startupMilliseconds" | "uploadBytes">,
  ProofError
> =>
  Effect.gen(function* () {
    const bundlePath = `${options.temporaryDirectory}/document-extraction-worker.js`;
    const profilePath = `${options.temporaryDirectory}/extraction-startup.cpuprofile`;
    const bundleOutput = runWrangler(
      [
        options.wranglerPath,
        "deploy",
        "--dry-run",
        "--config",
        options.configPath,
        "--outfile",
        bundlePath,
      ],
      options.infrastructureRoot
    );
    runWrangler(
      [
        options.wranglerPath,
        "check",
        "startup",
        "--workerBundle",
        bundlePath,
        "--outfile",
        profilePath,
      ],
      options.infrastructureRoot
    );
    const bundleBytes = (yield* fromPromise(() => stat(bundlePath))).size;
    const uploadMatch = /Total Upload: (?<kibibytes>[\d.]+) KiB/u.exec(bundleOutput);
    const uploadBytes = Math.ceil(Number(uploadMatch?.groups?.kibibytes) * kibibyte);
    const profile = yield* Schema.decodeEffect(Schema.fromJsonString(StartupProfile))(
      yield* fromPromise(() => readFile(profilePath, "utf8"))
    );
    const startupMilliseconds = (profile.endTime - profile.startTime) / microsecondsPerMillisecond;
    if (
      !Number.isFinite(uploadBytes) ||
      uploadBytes > options.maximumBundleBytes ||
      startupMilliseconds > options.maximumStartupMilliseconds ||
      !bundleOutput.includes("env.AI") ||
      !bundleOutput.includes("AI")
    ) {
      throw new Error("Workers AI extraction bundle, binding, or startup evidence is invalid");
    }
    return { bundleBytes, startupMilliseconds, uploadBytes };
  });

const requestReadiness = (signal: AbortSignal): Promise<Response> =>
  fetch(`http://127.0.0.1:${serverPort}/extract`, {
    body: "not a document",
    method: "POST",
    signal,
  });

const waitUntilReady = Effect.gen(function* () {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const ready = yield* fromPromise(requestReadiness).pipe(
      Effect.map((response) => response.status === unprocessableContentStatus),
      Effect.catch(() => Effect.sleep(readinessRetryMilliseconds).pipe(Effect.as(false)))
    );
    if (ready) return;
  }
  throw new Error("Document extraction workerd did not start");
});

const profileSuccessfulConversion = (
  debuggerUrl: string,
  body: Uint8Array,
  claimedContentType: string
): Effect.Effect<number, ProofError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < conversionAttempts; attempt += 1) {
      const profile = yield* fromPromise((signal) =>
        profileWorkerRequest({
          debuggerUrl,
          sendRequest: (requestSignal) =>
            fetch(`http://127.0.0.1:${serverPort}/extract`, {
              body,
              headers: { "content-type": claimedContentType },
              method: "POST",
              signal: requestSignal,
            }),
          signal: Option.some(signal),
        })
      );
      if (profile.response.ok) {
        const converted = yield* Schema.decodeUnknownEffect(ConvertedResult)(
          yield* fromPromise(() => profile.response.json())
        );
        if (converted.outputBytes > 0) return profile.cpuMilliseconds;
      } else {
        yield* fromPromise(() => profile.response.body?.cancel() ?? Promise.resolve());
      }
    }
    throw new Error("Workers AI did not convert a valid fixture through workerd");
  });

const proveValidConversions = (
  debuggerUrl: string,
  infrastructureRoot: string
): Effect.Effect<
  {
    readonly imageCpuMilliseconds: number;
    readonly pdfCpuMilliseconds: number;
    readonly validImage: Uint8Array;
  },
  ProofError
> =>
  Effect.gen(function* () {
    const validPdf = yield* fromPromise(() =>
      readFile(`${infrastructureRoot}/fixtures/valid-document.pdf`)
    );
    const pdfCpuMilliseconds = yield* profileSuccessfulConversion(
      debuggerUrl,
      validPdf,
      "image/png"
    );
    const validImage = yield* fromPromise(() =>
      readFile(`${infrastructureRoot}/fixtures/valid-image.png`)
    );
    const imageCpuMilliseconds = yield* profileSuccessfulConversion(
      debuggerUrl,
      validImage,
      "application/pdf"
    );
    return { imageCpuMilliseconds, pdfCpuMilliseconds, validImage };
  });

const proveHostileInputs = (
  infrastructureRoot: string,
  validImage: Uint8Array
): Effect.Effect<void, ProofError> =>
  Effect.gen(function* () {
    const inputs: ReadonlyArray<{
      readonly body: string | Uint8Array;
      readonly expectedReason: string;
      readonly expectedStatus: number;
      readonly label: string;
    }> = [
      {
        body: "not a document",
        expectedReason: "unsupported-format",
        expectedStatus: unprocessableContentStatus,
        label: "unknown-bytes",
      },
      {
        body: "%PDF-1.7\nmissing trailer",
        expectedReason: "malformed-file",
        expectedStatus: unprocessableContentStatus,
        label: "truncated-pdf",
      },
      {
        body: Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgD/////AAAAAQ=="),
        expectedReason: "resource-limit",
        expectedStatus: payloadTooLargeStatus,
        label: "oversized-image-dimensions",
      },
      {
        body: validImage.subarray(0, truncatedImageHeaderBytes),
        expectedReason: "conversion-failed",
        expectedStatus: unprocessableContentStatus,
        label: "malformed-image-provider-rejection",
      },
      {
        body: yield* fromPromise(() =>
          readFile(`${infrastructureRoot}/fixtures/protected-document.pdf`)
        ),
        expectedReason: "password-required",
        expectedStatus: unprocessableContentStatus,
        label: "protected-pdf-password",
      },
    ];
    for (const input of inputs) {
      const response = yield* fromPromise((signal) =>
        fetch(`http://127.0.0.1:${serverPort}/extract`, {
          body: input.body,
          method: "POST",
          signal,
        })
      );
      const rejected = yield* Schema.decodeUnknownEffect(RejectedResult)(
        yield* fromPromise(() => response.json())
      );
      if (response.status !== input.expectedStatus || rejected.reason !== input.expectedReason) {
        throw new Error(`Document extraction did not fail closed for ${input.label}`);
      }
    }
  });

const stopWorker = (process: Bun.Subprocess): Effect.Effect<void> =>
  Effect.sync(() => process.kill()).pipe(
    Effect.flatMap(() => fromPromise(() => process.exited)),
    Effect.asVoid,
    Effect.orDie
  );

const runtimeProof = (options: ProofOptions): Effect.Effect<RuntimeProof, ProofError> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(
            [
              options.wranglerPath,
              "dev",
              "--config",
              options.configPath,
              "--port",
              String(serverPort),
              "--inspector-port",
              String(inspectorPort),
              "--persist-to",
              `${options.temporaryDirectory}/extraction-state`,
              "--no-show-interactive-dev-session",
            ],
            { cwd: options.infrastructureRoot, stderr: "ignore", stdout: "ignore" }
          )
        ),
        (process) => stopWorker(process)
      );
      yield* waitUntilReady;
      const debuggerUrl = yield* fromPromise((signal) =>
        inspectorTarget({ port: inspectorPort, signal: Option.some(signal) })
      );
      const baselineHeapBytes = yield* fromPromise((signal) =>
        heapUsage({ debuggerUrl, signal: Option.some(signal) })
      );
      const conversions = yield* proveValidConversions(debuggerUrl, options.infrastructureRoot);
      yield* proveHostileInputs(options.infrastructureRoot, conversions.validImage);
      const retainedHeapBytes = yield* fromPromise((signal) =>
        heapUsage({ debuggerUrl, signal: Option.some(signal) })
      );
      if (
        retainedHeapBytes > options.maximumMemoryBytes ||
        !Number.isFinite(conversions.pdfCpuMilliseconds) ||
        !Number.isFinite(conversions.imageCpuMilliseconds)
      ) {
        throw new Error("Document extraction has invalid Worker resource evidence");
      }
      return {
        imageCpuMilliseconds: conversions.imageCpuMilliseconds,
        pdfCpuMilliseconds: conversions.pdfCpuMilliseconds,
        retainedHeapBytes,
        retainedHeapGrowthBytes: retainedHeapBytes - baselineHeapBytes,
      };
    })
  );

/** Builds the extraction proof and, when authorized, runs the bounded workerd probes. */
export const runExtractionProof = (options: ProofOptions): Promise<ExtractionProof> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const build = yield* buildProof(options);
      if (!options.runAuthenticatedRuntime) {
        return {
          ...build,
          connectionUpperBound,
          runtimeStatus: "credentials-required" as const,
        };
      }
      const runtime = yield* runtimeProof(options);
      return {
        ...build,
        ...runtime,
        connectionUpperBound,
        runtimeStatus: "authenticated" as const,
        workerdProbes,
      };
    })
  );
