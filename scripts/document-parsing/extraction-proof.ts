import { readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
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

const runWrangler = (command: Array<string>, cwd: string): string => {
  const result = Bun.spawnSync(command, { cwd, stderr: "inherit", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Extraction proof command failed: ${command[1]}`);
  return new TextDecoder().decode(result.stdout);
};

// @effect-diagnostics-next-line asyncFunction:off -- executable build harness around Bun and Wrangler.
const buildProof = async (
  options: ProofOptions
): Promise<Pick<ExtractionProof, "bundleBytes" | "startupMilliseconds" | "uploadBytes">> => {
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
  const bundleBytes = (await stat(bundlePath)).size;
  const uploadMatch = /Total Upload: (?<kibibytes>[\d.]+) KiB/u.exec(bundleOutput);
  const uploadBytes = Math.ceil(Number(uploadMatch?.groups?.kibibytes) * kibibyte);
  const profile = Schema.decodeSync(Schema.fromJsonString(StartupProfile))(
    await readFile(profilePath, "utf8")
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
};

// @effect-diagnostics-next-line asyncFunction:off -- bounded workerd readiness polling.
const waitUntilReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/extract`, {
        body: "not a document",
        method: "POST",
      });
      if (response.status === unprocessableContentStatus) return;
    } catch {
      await Bun.sleep(readinessRetryMilliseconds);
    }
  }
  throw new Error("Document extraction workerd did not start");
};

// @effect-diagnostics-next-line asyncFunction:off -- bounded retry around a remote proof call.
const profileSuccessfulConversion = async (
  debuggerUrl: string,
  body: Uint8Array,
  claimedContentType: string
): Promise<number> => {
  for (let attempt = 0; attempt < conversionAttempts; attempt += 1) {
    const profile = await profileWorkerRequest(debuggerUrl, () =>
      fetch(`http://127.0.0.1:${serverPort}/extract`, {
        body,
        headers: { "content-type": claimedContentType },
        method: "POST",
      })
    );
    if (profile.response.ok) {
      const converted = Schema.decodeUnknownSync(ConvertedResult)(await profile.response.json());
      if (converted.outputBytes > 0) return profile.cpuMilliseconds;
    }
  }
  throw new Error("Workers AI did not convert a valid fixture through workerd");
};

// @effect-diagnostics-next-line asyncFunction:off -- sequential external runtime measurements.
const proveValidConversions = async (
  debuggerUrl: string,
  infrastructureRoot: string
): Promise<{
  readonly imageCpuMilliseconds: number;
  readonly pdfCpuMilliseconds: number;
  readonly validImage: Uint8Array;
}> => {
  const validPdf = await readFile(`${infrastructureRoot}/fixtures/valid-document.pdf`);
  const pdfCpuMilliseconds = await profileSuccessfulConversion(debuggerUrl, validPdf, "image/png");
  const validImage = await readFile(`${infrastructureRoot}/fixtures/valid-image.png`);
  const imageCpuMilliseconds = await profileSuccessfulConversion(
    debuggerUrl,
    validImage,
    "application/pdf"
  );
  return { imageCpuMilliseconds, pdfCpuMilliseconds, validImage };
};

// @effect-diagnostics-next-line asyncFunction:off -- sequential HTTP proof fixture runner.
const proveHostileInputs = async (
  infrastructureRoot: string,
  validImage: Uint8Array
): Promise<void> => {
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
      body: await readFile(`${infrastructureRoot}/fixtures/protected-document.pdf`),
      expectedReason: "password-required",
      expectedStatus: unprocessableContentStatus,
      label: "protected-pdf-password",
    },
  ];
  for (const input of inputs) {
    const response = await fetch(`http://127.0.0.1:${serverPort}/extract`, {
      body: input.body,
      method: "POST",
    });
    const rejected = Schema.decodeUnknownSync(RejectedResult)(await response.json());
    if (response.status !== input.expectedStatus || rejected.reason !== input.expectedReason) {
      throw new Error(`Document extraction did not fail closed for ${input.label}`);
    }
  }
};

// @effect-diagnostics-next-line asyncFunction:off -- scoped workerd subprocess harness.
const runtimeProof = async (options: ProofOptions): Promise<RuntimeProof> => {
  const worker = Bun.spawn(
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
  );
  try {
    await waitUntilReady();
    const debuggerUrl = await inspectorTarget(inspectorPort);
    const baselineHeapBytes = await heapUsage(debuggerUrl);
    const conversions = await proveValidConversions(debuggerUrl, options.infrastructureRoot);
    await proveHostileInputs(options.infrastructureRoot, conversions.validImage);
    const retainedHeapBytes = await heapUsage(debuggerUrl);
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
  } finally {
    worker.kill();
    await worker.exited;
  }
};

// @effect-diagnostics-next-line asyncFunction:off -- executable proof script API.
export const runExtractionProof = async (options: ProofOptions): Promise<ExtractionProof> => {
  const build = await buildProof(options);
  if (!options.runAuthenticatedRuntime) {
    return {
      ...build,
      connectionUpperBound,
      runtimeStatus: "credentials-required",
    };
  }
  const runtime = await runtimeProof(options);
  return {
    ...build,
    ...runtime,
    connectionUpperBound,
    runtimeStatus: "authenticated",
    workerdProbes,
  };
};
