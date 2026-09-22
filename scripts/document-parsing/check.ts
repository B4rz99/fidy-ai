#!/usr/bin/env bun

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { Schema } from "effect";
import * as XLSX from "xlsx/xlsx.mjs";
import { runExtractionProof } from "./extraction-proof";
import { runProtectedDocumentProof } from "./protected-document-proof";
import { heapUsage, inspectorTarget, profileWorkerRequest } from "./workerd-inspector";

const kibibyte = Number("1024");
const mebibyte = Number("1048576");
const maximumBundleBytes = Number("64") * mebibyte;
const maximumMemoryBytes = Number("128") * mebibyte;
const maximumStartupMilliseconds = Number("1000");
const startupMicrosecondsPerMillisecond = Number("1000");
const readinessAttempts = Number("80");
const readinessRetryMilliseconds = Number("100");
const unprocessableContentStatus = Number("422");
const payloadTooLargeStatus = Number("413");
const zipCentralHeaderLength = Number("46");
const zipCentralSignature = Number("0x02014b50");
const zipExpandedSizeOffset = Number("24");
const forgedExpandedBytes = Number("26") * mebibyte;
const representativeXlsxRows = Number("20000");
const representativeXlsxColumns = Number("12");
const serverPort = 8793;
const inspectorPort = 9293;
const infrastructureRoot = new URL("../../infra/cloudflare/", import.meta.url).pathname;
const workspaceRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectory = `${workspaceRoot}/.document-parsing-proof`;
const bundlePath = `${temporaryDirectory}/document-parsing-worker.js`;
const profilePath = `${temporaryDirectory}/startup.cpuprofile`;
const extractionConfigPath = `${infrastructureRoot}/document-extraction.wrangler.jsonc`;
const protectedConfigPath = `${infrastructureRoot}/protected-document.wrangler.jsonc`;
const configPath = `${infrastructureRoot}/document-parsing.wrangler.jsonc`;
const wranglerPath = `${workspaceRoot}/node_modules/.bin/wrangler`;

const StartupProfile = Schema.Struct({ endTime: Schema.Finite, startTime: Schema.Finite });
const ParseResult = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  format: Schema.Literals(["csv", "xlsx"]),
  outcome: Schema.Literal("parsed"),
  rowCount: Schema.Int,
});
const RejectedResult = Schema.Struct({
  outcome: Schema.Literal("rejected"),
  reason: Schema.String,
});
const WranglerProofConfig = Schema.Struct({
  compatibility_date: Schema.String,
  limits: Schema.Struct({ cpu_ms: Schema.Int }),
});
const decodeProofConfig = Schema.decodeSync(Schema.fromJsonString(WranglerProofConfig));
const removeJsoncTrailingCommas = (contents: string): string =>
  contents.replace(/,\s*(?<closingToken>[}\]])/gu, "$<closingToken>");
const config = decodeProofConfig(removeJsoncTrailingCommas(await readFile(configPath, "utf8")));
const protectedConfig = decodeProofConfig(
  removeJsoncTrailingCommas(await readFile(protectedConfigPath, "utf8"))
);
const extractionConfig = decodeProofConfig(
  removeJsoncTrailingCommas(await readFile(extractionConfigPath, "utf8"))
);
if (
  protectedConfig.compatibility_date !== config.compatibility_date ||
  protectedConfig.limits.cpu_ms !== config.limits.cpu_ms ||
  extractionConfig.compatibility_date !== config.compatibility_date ||
  extractionConfig.limits.cpu_ms !== config.limits.cpu_ms
) {
  throw new Error("Document proof Workers must pin the same compatibility and CPU limits");
}
const maximumCpuMilliseconds = config.limits.cpu_ms;

const runWranglerCommand = (command: Array<string>): string => {
  const result = Bun.spawnSync(command, {
    cwd: infrastructureRoot,
    stderr: "inherit",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Document parsing proof command failed: ${command[1]}`);
  }
  return new TextDecoder().decode(result.stdout);
};

const workbookBytes = (workbook: XLSX.WorkBook, bookType: "xlsx" | "xlsm"): Uint8Array => {
  const buffer: unknown = XLSX.write(workbook, { bookType, compression: true, type: "array" });
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error("SheetJS did not produce an ArrayBuffer");
  }
  return new Uint8Array(buffer);
};

const forgeExpandedSize = (original: Uint8Array): Uint8Array => {
  const bytes = original.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + zipCentralHeaderLength <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === zipCentralSignature) {
      view.setUint32(offset + zipExpandedSizeOffset, forgedExpandedBytes, true);
      return bytes;
    }
  }
  throw new Error("Generated XLSX has no central directory entry");
};

await rm(temporaryDirectory, { force: true, recursive: true });
await mkdir(temporaryDirectory, { recursive: true });

const bundleOutput = runWranglerCommand([
  wranglerPath,
  "deploy",
  "--dry-run",
  "--config",
  configPath,
  "--outfile",
  bundlePath,
  "--metafile",
  `${temporaryDirectory}/bundle-meta.json`,
]);
const emittedBundleBytes = (await stat(bundlePath)).size;
const uploadSizeMatch = /Total Upload: (?<kibibytes>[\d.]+) KiB/u.exec(bundleOutput);
const uploadKibibytes = Number(uploadSizeMatch?.groups?.kibibytes);
if (!Number.isFinite(uploadKibibytes) || !bundleOutput.includes("No bindings found.")) {
  throw new Error("Wrangler did not report an unbound production-like Worker upload");
}
const bundleBytes = Math.ceil(uploadKibibytes * kibibyte);
if (bundleBytes > maximumBundleBytes) {
  throw new Error("Document parser exceeds the Worker bundle limit");
}

const startupOutput = runWranglerCommand([
  wranglerPath,
  "check",
  "startup",
  "--workerBundle",
  bundlePath,
  "--outfile",
  profilePath,
]);
const protectedBundleBytes = await runProtectedDocumentProof({
  configPath: protectedConfigPath,
  infrastructureRoot,
  temporaryDirectory,
  wranglerPath,
});

const profile = Schema.decodeSync(Schema.fromJsonString(StartupProfile))(
  await readFile(profilePath, "utf8")
);
const startupMilliseconds =
  (profile.endTime - profile.startTime) / startupMicrosecondsPerMillisecond;
if (startupMilliseconds > maximumStartupMilliseconds) {
  throw new Error("Document parser exceeds the Worker startup limit");
}

const extractionProof = await runExtractionProof({
  configPath: extractionConfigPath,
  infrastructureRoot,
  maximumBundleBytes,
  maximumMemoryBytes,
  maximumStartupMilliseconds,
  runAuthenticatedRuntime: Bun.argv.includes("--remote"),
  temporaryDirectory,
  wranglerPath,
});

const worker = Bun.spawn(
  [
    wranglerPath,
    "dev",
    "--config",
    configPath,
    "--port",
    String(serverPort),
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    `${temporaryDirectory}/statement-state`,
    "--no-show-interactive-dev-session",
  ],
  { cwd: infrastructureRoot, stderr: "ignore", stdout: "ignore" }
);

try {
  let ready = false;
  for (let attempt = 0; attempt < readinessAttempts && !ready; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/statement`, {
        body: "Date,Amount\n2026-01-01,1",
        method: "POST",
      });
      ready = response.ok;
    } catch {
      await Bun.sleep(readinessRetryMilliseconds);
    }
  }
  if (!ready) {
    throw new Error("Document parser workerd did not start");
  }

  const debuggerUrl = await inspectorTarget(inspectorPort);
  const baselineHeapBytes = await heapUsage(debuggerUrl);

  const rows = Array.from(
    { length: 20_000 },
    (_, index) => `2026-01-01,${index},bounded representative row ${index}`
  );
  const csvProfile = await profileWorkerRequest(debuggerUrl, () =>
    fetch(`http://127.0.0.1:${serverPort}/statement`, {
      body: `Date,Amount,Description\n${rows.join("\n")}`,
      headers: { "content-type": "application/pdf" },
      method: "POST",
    })
  );
  const response = csvProfile.response;
  const parsed = Schema.decodeUnknownSync(ParseResult)(await response.json());
  if (!response.ok || parsed.format !== "csv" || parsed.rowCount !== rows.length) {
    throw new Error("Document parser failed the bounded workerd fixture");
  }
  if (csvProfile.cpuMilliseconds > maximumCpuMilliseconds) {
    throw new Error("Document parser exceeds the configured Worker CPU limit");
  }

  const unsupportedDocuments: ReadonlyArray<{
    readonly body: string | Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
    readonly label: string;
  }> = [
    {
      body: "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF",
      headers: {},
      label: "pdf",
    },
    {
      body: Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgD/////AAAAAQ=="),
      headers: {},
      label: "oversized-image-dimensions",
    },
    {
      body: await readFile(`${infrastructureRoot}/fixtures/protected-document.pdf`),
      headers: { "x-document-password": "proof-password" },
      label: "protected-pdf-password",
    },
  ];
  for (const document of unsupportedDocuments) {
    const unsupportedResponse = await fetch(`http://127.0.0.1:${serverPort}/statement`, {
      body: document.body,
      headers: document.headers,
      method: "POST",
    });
    const rejected = Schema.decodeUnknownSync(RejectedResult)(await unsupportedResponse.json());
    if (
      unsupportedResponse.status !== unprocessableContentStatus ||
      rejected.reason !== "unsupported-format"
    ) {
      throw new Error(`Document parser did not fail closed for ${document.label}`);
    }
  }

  const activeWorkbookFixtures = ["SimpleMacro.xlsm", "link-external-workbook-a.xlsx"];
  for (const fixture of activeWorkbookFixtures) {
    const activeResponse = await fetch(`http://127.0.0.1:${serverPort}/statement`, {
      body: await readFile(`${infrastructureRoot}/fixtures/${fixture}`),
      method: "POST",
    });
    const activeResult = Schema.decodeUnknownSync(ParseResult)(await activeResponse.json());
    if (!activeResponse.ok || activeResult.format !== "xlsx") {
      throw new Error(`Workerd did not safely parse hostile workbook structure: ${fixture}`);
    }
  }

  const oversizedWorkbook = XLSX.utils.book_new();
  const oversizedSheet = XLSX.utils.aoa_to_sheet([["Date", "Amount"]]);
  oversizedSheet["!ref"] = "A1:B20002";
  XLSX.utils.book_append_sheet(oversizedWorkbook, oversizedSheet, "Oversized");
  const ordinaryWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    ordinaryWorkbook,
    XLSX.utils.aoa_to_sheet([["Date"], ["2026-01-01"]]),
    "Statement"
  );
  const hostileWorkbooks = [
    {
      body: workbookBytes(oversizedWorkbook, "xlsx"),
      expectedReason: "resource-limit",
      expectedStatus: payloadTooLargeStatus,
      label: "oversized-xlsx-dimensions",
    },
    {
      body: forgeExpandedSize(workbookBytes(ordinaryWorkbook, "xlsx")),
      expectedReason: "malformed-file",
      expectedStatus: unprocessableContentStatus,
      label: "forged-xlsx-expansion",
    },
    {
      body: new TextEncoder().encode('A,B\n"unterminated,2'),
      expectedReason: "malformed-file",
      expectedStatus: unprocessableContentStatus,
      label: "malformed-csv",
    },
  ];
  for (const hostile of hostileWorkbooks) {
    const hostileResponse = await fetch(`http://127.0.0.1:${serverPort}/statement`, {
      body: hostile.body,
      method: "POST",
    });
    const rejected = Schema.decodeUnknownSync(RejectedResult)(await hostileResponse.json());
    if (
      hostileResponse.status !== hostile.expectedStatus ||
      rejected.reason !== hostile.expectedReason
    ) {
      throw new Error(`Workerd did not reject ${hostile.label}`);
    }
  }

  const representativeHeaders = Array.from({ length: representativeXlsxColumns }, (_, index) =>
    index === 0 ? "Date" : `Field${index}`
  );
  const representativeRows = Array.from({ length: representativeXlsxRows }, () =>
    Array.from({ length: representativeXlsxColumns }, (_, index) =>
      index === 0 ? "2026-01-01" : "bounded"
    )
  );
  const representativeWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    representativeWorkbook,
    XLSX.utils.aoa_to_sheet([representativeHeaders, ...representativeRows]),
    "Statement"
  );
  const xlsxProfile = await profileWorkerRequest(debuggerUrl, () =>
    fetch(`http://127.0.0.1:${serverPort}/statement`, {
      body: workbookBytes(representativeWorkbook, "xlsx"),
      method: "POST",
    })
  );
  const xlsxResponse = xlsxProfile.response;
  const parsedXlsx = Schema.decodeUnknownSync(ParseResult)(await xlsxResponse.json());
  if (
    !xlsxResponse.ok ||
    parsedXlsx.format !== "xlsx" ||
    parsedXlsx.rowCount !== representativeXlsxRows
  ) {
    throw new Error("Document parser failed the near-limit XLSX workerd fixture");
  }
  if (xlsxProfile.cpuMilliseconds > maximumCpuMilliseconds) {
    throw new Error("XLSX parsing exceeds the configured Worker CPU limit");
  }

  const retainedHeapBytes = await heapUsage(debuggerUrl);
  if (retainedHeapBytes > maximumMemoryBytes) {
    throw new Error("Document parser exceeds the Worker memory limit");
  }

  const extractionRuntimeEvidence =
    extractionProof.runtimeStatus === "authenticated"
      ? {
          extractionRetainedHeapBytes: extractionProof.retainedHeapBytes,
          extractionRetainedHeapGrowthBytes: extractionProof.retainedHeapGrowthBytes,
          extractionRuntimeStatus: extractionProof.runtimeStatus,
          extractionWorkerdProbes: extractionProof.workerdProbes,
          imageExtractionCpuMilliseconds: extractionProof.imageCpuMilliseconds,
          pdfExtractionCpuMilliseconds: extractionProof.pdfCpuMilliseconds,
        }
      : { extractionRuntimeStatus: extractionProof.runtimeStatus };

  process.stdout.write(
    `${JSON.stringify(
      {
        bundleBytes,
        compatibilityDate: config.compatibility_date,
        configuredBindings: "none-reported-by-wrangler",
        configuredCpuMilliseconds: maximumCpuMilliseconds,
        csvCpuMilliseconds: csvProfile.cpuMilliseconds,
        csvHandlerElapsedMilliseconds: parsed.elapsedMilliseconds,
        emittedBundleBytes,
        extractionBundleBytes: extractionProof.bundleBytes,
        extractionConnectionUpperBound: extractionProof.connectionUpperBound,
        ...extractionRuntimeEvidence,
        extractionStartupMilliseconds: extractionProof.startupMilliseconds,
        extractionUploadBytes: extractionProof.uploadBytes,
        protectedDocumentBundleBytes: protectedBundleBytes,
        protectedDocumentStartup: "failed-createRequire-before-WASM-load",
        retainedHeapBytes,
        retainedHeapGrowthBytes: retainedHeapBytes - baselineHeapBytes,
        startupMilliseconds,
        unsupportedWorkerdProbes: unsupportedDocuments.map((document) => document.label),
        workerdHostileProbes: hostileWorkbooks.map((hostile) => hostile.label),
        xlsxCpuMilliseconds: xlsxProfile.cpuMilliseconds,
        xlsxHandlerElapsedMilliseconds: parsedXlsx.elapsedMilliseconds,
      },
      undefined,
      2
    )}\n`
  );
} finally {
  worker.kill();
  await worker.exited;
  await rm(temporaryDirectory, { force: true, recursive: true });
}

if (!bundleOutput.includes("Total Upload") || !startupOutput.includes("Startup phase analysed")) {
  throw new Error("Wrangler did not report production-like bundle and startup evidence");
}
