#!/usr/bin/env bun
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { Crypto, Effect, FileSystem, Option, Schema } from "effect";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx/xlsx.mjs";
import type { WorkBook, WorkSheet } from "xlsx";
import {
  closeWorkerdHttp,
  proofHttpClientLayer,
  requestHostedProof,
  requestWorkerd,
} from "./local-workerd-http";
import { heapUsage, inspectorTarget, profileWorkerRequest } from "./workerd-inspector";
import { type HostedWorkerProof, hostedWorkerProof } from "./hosted-worker";
import { stopProofProcess } from "./proof-command";

const baseline = process.argv.includes("--baseline");
const remote = process.argv.includes("--remote");
const durable = process.argv.includes("--durable");
if (durable && !remote) throw new Error("Durable proof requires hosted mode");
const hostedRuntime = durable ? "cloudflare-durable-object" : "cloudflare-worker";
if (baseline && remote) throw new Error("Hosted proof only supports the current bounded parser");
const port = 8795;
const proofNameSuffixLength = 8;
const inspectorPort = 9295;
const readinessAttempts = 80;
const readinessDelay = 500;
const localRequestTimeout = 1000;
const remoteRequestTimeout = 5000;
const requestTimeout = remote ? remoteRequestTimeout : localRequestTimeout;
const cpuLimit = 30000;
const smallStatementRows = 8;
const mediumStatementRows = 32;
const largerStatementRows = 128;
const thousandStatementRows = 1000;
const malformedFileStatus = 422;
const sharedLength = 4096;
const formattedRows = 512;
const boundedRows = 8000;
const escapedRepetitions = 1024;
const outsideNumericDigits = 129;
const root = new URL("../..", import.meta.url).pathname;
const directory = `${root}/.xlsx-work-proof`;
const fixtureRoot = `${root}/scripts/document-parsing/fixtures/xlsx-work`;
const workResult = Schema.Struct({
  outcome: Schema.Literal("parsed"),
  rowCount: Schema.Int,
  elapsedMilliseconds: Schema.Finite,
  interpretationMilliseconds: Schema.Finite,
  logicalTextBytes: Schema.Int,
  serializedEvidenceBytes: Schema.Int,
  interpretedRows: Schema.Int,
  acceptedRows: Schema.Int,
  reviewRows: Schema.Int,
});
const parsedOnly = Schema.Struct({
  outcome: Schema.Literal("parsed"),
  rowCount: Schema.Int,
  elapsedMilliseconds: Schema.Finite,
});
const rejected = Schema.Struct({ outcome: Schema.Literal("rejected"), reason: Schema.String });
const runtimeFailure = Schema.Struct({
  outcome: Schema.Literal("runtime-failure"),
  httpStatus: Schema.Int,
  cloudflareErrorCode: Schema.optional(Schema.String),
});
const decodeResponse = Schema.decodeUnknownSync(Schema.Union([workResult, parsedOnly, rejected]));
const readProofResponse = Effect.fn(function* (response: Response) {
  if (response.headers.get("content-type")?.includes("application/json") === true) {
    return decodeResponse(yield* Effect.tryPromise(() => response.json()));
  }
  const body = yield* Effect.tryPromise(() => response.text());
  const errorCode = /(?:error code:|Error)\s*(\d{4})/iu.exec(body)?.[1];
  return {
    outcome: "runtime-failure" as const,
    httpStatus: response.status,
    cloudflareErrorCode: errorCode,
  };
});

const measurementBase = Schema.Struct({
  baseline: Schema.Boolean,
  runtime: Schema.Literals(["local-workerd", "cloudflare-worker", "cloudflare-durable-object"]),
  fixture: Schema.String,
  zipBytes: Schema.Int,
  expandedBytes: Schema.Int,
  requestRoundTripMilliseconds: Schema.Finite,
  sampledV8ActiveMilliseconds: Schema.optional(Schema.Finite),
  retainedHeapBeforeBytes: Schema.optional(Schema.Int),
  retainedHeapAfterBytes: Schema.optional(Schema.Int),
});
const measurementCodec = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ...measurementBase.fields, ...workResult.fields }),
    Schema.Struct({ ...measurementBase.fields, ...parsedOnly.fields }),
    Schema.Struct({ ...measurementBase.fields, ...rejected.fields }),
    Schema.Struct({ ...measurementBase.fields, ...runtimeFailure.fields }),
  ])
);
const overlapCodec = Schema.fromJsonString(
  Schema.Struct({
    baseline: Schema.Boolean,
    runtime: Schema.Literals(["local-workerd", "cloudflare-worker", "cloudflare-durable-object"]),
    fixture: Schema.String,
    elapsedMilliseconds: Schema.Finite,
    outcomes: Schema.Array(Schema.Literals(["parsed", "rejected", "runtime-failure"])),
    retainedHeapAfterBytes: Schema.optional(Schema.Int),
  })
);
const configCodec = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    main: Schema.String,
    compatibility_date: Schema.String,
    limits: Schema.optionalKey(Schema.Struct({ cpu_ms: Schema.Int })),
    workers_dev: Schema.Boolean,
    preview_urls: Schema.Boolean,
    durable_objects: Schema.optionalKey(
      Schema.Struct({
        bindings: Schema.Array(Schema.Struct({ name: Schema.String, class_name: Schema.String })),
      })
    ),
    migrations: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          tag: Schema.String,
          new_sqlite_classes: Schema.optionalKey(Schema.Array(Schema.String)),
          deleted_classes: Schema.optionalKey(Schema.Array(Schema.String)),
        })
      )
    ),
  })
);
const writeWorkbook = (book: WorkBook): Uint8Array => {
  const fresh: WorkBook & { SSF: Record<number, string> } = { ...book, SSF: { 0: "General" } };
  const buffer: unknown = XLSX.write(fresh, { type: "array", compression: true, bookSST: true });
  if (!(buffer instanceof ArrayBuffer)) throw new Error("Expected workbook bytes");
  return new Uint8Array(buffer);
};
const synthetic = (
  input: Readonly<{ rows: number; text: string; formatted: boolean }>
): Uint8Array => {
  const rows = Array.from({ length: input.rows }, (_, index) => [
    "2026-01-01",
    String(index + 1),
    "COP",
    input.text,
  ]);
  const sheet: WorkSheet = XLSX.utils.aoa_to_sheet([
    ["fecha", "valor", "moneda", "contraparte"],
    ...rows,
  ]);
  if (input.formatted) {
    for (let index = 0; index < input.rows; index += 1) {
      sheet[`D${index + 2}`] = { t: "s", v: input.text, z: '@"suffix"' };
    }
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Statement");
  return writeWorkbook(book);
};
const manyCells = (rows = 20000): Uint8Array => {
  const columns = 12;
  const book = XLSX.utils.book_new();
  const data = [
    Array.from({ length: columns }, (_, index) => `Header${index}`),
    ...Array.from({ length: rows }, (_, index) => Array.from({ length: columns }, () => index + 1)),
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), "Statement");
  return writeWorkbook(book);
};
const longAmount = (): Uint8Array => {
  const source = synthetic({ rows: 1, text: "Cafe", formatted: false });
  const entries = unzipSync(source);
  const name = "xl/sharedStrings.xml";
  entries[name] = strToU8(
    strFromU8(entries[name] ?? new Uint8Array()).replace(
      "<t>1</t>",
      `<t>${"1".repeat(outsideNumericDigits)}</t>`
    )
  );
  return zipSync(entries);
};
const fixtures = Effect.fn(function* () {
  return [
    ...(yield* Effect.forEach(
      [
        "shared-string-small",
        "shared-string-row-limit",
        "shared-string-total-limit",
        "shared-string-accepted",
        "shared-string-review",
        "shared-string-repeated-accepted",
      ],
      (name) =>
        Effect.tryPromise(() => Bun.file(`${fixtureRoot}/${name}.xlsx`).bytes()).pipe(
          Effect.map((bytes) => ({ name, bytes }))
        )
    )),
    ...[1, smallStatementRows, mediumStatementRows, largerStatementRows].map((rows) => ({
      name: `ordinary-${rows}-rows`,
      bytes: synthetic({ rows, text: "Cafe", formatted: false }),
    })),
    {
      name: "different-amounts",
      bytes: synthetic({
        rows: 1000,
        text: " ".repeat(sharedLength - 4) + "Cafe",
        formatted: false,
      }),
    },
    {
      name: "escaped-formatted",
      bytes: synthetic({ rows: 128, text: '"\\\n'.repeat(escapedRepetitions), formatted: true }),
    },
    {
      name: "formatted-work-outside-envelope",
      bytes: synthetic({ rows: formattedRows, text: "x".repeat(sharedLength), formatted: true }),
    },
    { name: "numeric-outside-envelope", bytes: longAmount() },
    { name: "many-cells", bytes: manyCells() },
    { name: "bounded-cells", bytes: manyCells(boundedRows) },
  ];
});
const send = (
  payload: Readonly<{ bytes: Uint8Array; path: "/statement" | "/statement-work" }>,
  signal: AbortSignal,
  target: Option.Option<HostedWorkerProof>
): Promise<Response> => {
  const input = {
    method: "POST" as const,
    port,
    path: payload.path,
    body: payload.bytes,
    headers: {},
    signal,
  };
  return Option.isSome(target)
    ? requestHostedProof({
        ...input,
        origin: target.value.origin,
        headers: { "X-Xlsx-Proof-Key": target.value.token },
      })
    : requestWorkerd(input);
};
const probeReady = Effect.fn(function* (target: Option.Option<HostedWorkerProof>) {
  const reply = yield* Effect.tryPromise(() =>
    send(
      {
        bytes: remote ? new Uint8Array() : synthetic({ rows: 1, text: "Cafe", formatted: false }),
        path: "/statement-work",
      },
      AbortSignal.timeout(requestTimeout),
      target
    )
  );
  yield* Effect.try(() => {
    if (remote ? reply.status !== malformedFileStatus : !reply.ok) {
      throw new Error("XLSX proof is not ready");
    }
  });
  const value = yield* Effect.tryPromise(() => reply.json());
  yield* Effect.try(() => {
    const parsed = decodeResponse(value);
    const ready = remote
      ? parsed.outcome === "rejected" && parsed.reason === "malformed-file"
      : parsed.outcome === "parsed" && parsed.rowCount === 1;
    if (!ready) {
      throw new Error("XLSX readiness fixture did not parse");
    }
  });
});
const waitReady = Effect.fn(function* (target: Option.Option<HostedWorkerProof>) {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const response = yield* Effect.result(probeReady(target));
    if (response._tag === "Success") return;
    yield* Effect.sleep(readinessDelay);
  }
  throw new Error("XLSX proof worker did not become ready");
});
const waitInspector = Effect.fn(function* () {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const target = yield* Effect.result(
      Effect.tryPromise(() =>
        inspectorTarget({
          port: inspectorPort,
          signal: Option.some(AbortSignal.timeout(requestTimeout)),
        })
      )
    );
    if (target._tag === "Success") return target.success;
    yield* Effect.sleep(readinessDelay);
  }
  throw new Error("XLSX proof inspector did not become ready");
});
const measure = Effect.fn(function* (
  fixture: Readonly<{ name: string; bytes: Uint8Array; path: "/statement" | "/statement-work" }>,
  debuggerUrl: string,
  target: Option.Option<HostedWorkerProof>
) {
  const expandedBytes = Object.values(unzipSync(fixture.bytes)).reduce(
    (sum, entry) => sum + entry.length,
    0
  );
  const before = remote
    ? undefined
    : yield* Effect.tryPromise(() => heapUsage({ debuggerUrl, signal: Option.none() }));
  const startedAt = performance.now();
  const profiled = remote
    ? {
        response: yield* Effect.tryPromise(() =>
          send(fixture, AbortSignal.timeout(cpuLimit), target)
        ),
        cpuMilliseconds: undefined,
      }
    : yield* Effect.tryPromise(() =>
        profileWorkerRequest({
          debuggerUrl,
          signal: Option.none(),
          sendRequest: (signal) => send(fixture, signal, target),
        })
      );
  const result = yield* readProofResponse(profiled.response);
  const requestRoundTripMilliseconds = performance.now() - startedAt;
  const after = remote
    ? undefined
    : yield* Effect.tryPromise(() => heapUsage({ debuggerUrl, signal: Option.none() }));
  const output = yield* Schema.encodeEffect(measurementCodec)({
    baseline,
    runtime: remote ? hostedRuntime : "local-workerd",
    fixture: fixture.name,
    zipBytes: fixture.bytes.length,
    expandedBytes,
    requestRoundTripMilliseconds,
    ...result,
    sampledV8ActiveMilliseconds: profiled.cpuMilliseconds,
    retainedHeapBeforeBytes: before,
    retainedHeapAfterBytes: after,
  });
  process.stdout.write(output + "\n");
});
const previousParser = baseline
  ? Bun.spawnSync(
      [
        "git",
        "show",
        "6ecbe8efbd33f0fc462f629823bddc641bad2e74:apps/server/src/shell/ingestion/internal/parser.ts",
      ],
      { cwd: root, timeout: 120_000, maxBuffer: 1_048_576, killSignal: "SIGKILL" }
    ).stdout.toString()
  : "";
const proofConfig = (name: string, retiring = false): string =>
  Schema.encodeSync(configCodec)({
    name,
    main: "worker.js",
    compatibility_date: "2026-09-08",
    ...(remote ? {} : { limits: { cpu_ms: cpuLimit } }),
    workers_dev: remote,
    preview_urls: false,
    ...(durable
      ? {
          durable_objects: {
            bindings: retiring ? [] : [{ name: "PARSER_PROOF", class_name: "XlsxParserProof" }],
          },
          migrations: [
            { tag: "created", new_sqlite_classes: ["XlsxParserProof"] },
            ...(retiring ? [{ tag: "retired", deleted_classes: ["XlsxParserProof"] }] : []),
          ],
        }
      : {}),
  });
const buildWorker = Effect.fn(function* (name: string) {
  const built = yield* Effect.tryPromise(() =>
    Bun.build({
      plugins: baseline
        ? [
            {
              name: "previous-parser",
              setup(build): void {
                build.onLoad({ filter: /shell\/ingestion\/internal\/parser\.ts$/u }, () => ({
                  contents: previousParser,
                  loader: "ts",
                }));
              },
            },
          ]
        : [],
      entrypoints: [
        durable
          ? `${root}/apps/server/cloudflare/documents/durable-parser-proof-worker.ts`
          : `${root}/apps/server/cloudflare/documents/document-parsing-worker.ts`,
      ],
      target: "browser",
      outdir: directory,
      naming: "worker.js",
    })
  );
  if (!built.success) throw new Error("XLSX proof bundle failed");
  yield* Effect.tryPromise(() => Bun.write(`${directory}/wrangler.json`, proofConfig(name)));
});
const startWorker = (): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(
    [
      `${root}/node_modules/.bin/wrangler`,
      "dev",
      "--config",
      `${directory}/wrangler.json`,
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--local",
      "--persist-to",
      `${directory}/state`,
    ],
    { stdout: "ignore", stderr: "inherit" }
  );

const overlapRequests = Effect.fn(function* (
  debuggerUrl: string,
  overlap: Uint8Array,
  input: Readonly<{ name: string; target: Option.Option<HostedWorkerProof> }>
) {
  const { name, target } = input;
  const startedAt = performance.now();
  const responses = yield* Effect.tryPromise(() =>
    Promise.all([
      send({ bytes: overlap, path: "/statement-work" }, AbortSignal.timeout(cpuLimit), target),
      send({ bytes: overlap, path: "/statement-work" }, AbortSignal.timeout(cpuLimit), target),
    ])
  );
  const results = yield* Effect.forEach(responses, readProofResponse);
  const retainedHeapAfterBytes = remote
    ? undefined
    : yield* Effect.tryPromise(() => heapUsage({ debuggerUrl, signal: Option.none() }));
  const output = yield* Schema.encodeEffect(overlapCodec)({
    baseline,
    runtime: remote ? hostedRuntime : "local-workerd",
    fixture: name,
    elapsedMilliseconds: performance.now() - startedAt,
    outcomes: results.map((result) => result.outcome),
    retainedHeapAfterBytes,
  });
  process.stdout.write(output + "\n");
});
const releaseWorker = (worker: Bun.Subprocess): Effect.Effect<void> =>
  Effect.tryPromise(() => stopProofProcess(worker)).pipe(Effect.orDie);
const measureParserOnly = Effect.fn(function* (
  debuggerUrl: string,
  target: Option.Option<HostedWorkerProof>
) {
  for (const rows of [
    1,
    smallStatementRows,
    mediumStatementRows,
    largerStatementRows,
    thousandStatementRows,
    boundedRows,
  ]) {
    yield* measure(
      {
        name: `parse-only-ordinary-${rows}-rows`,
        path: "/statement",
        bytes: synthetic({ rows, text: "Cafe", formatted: false }),
      },
      debuggerUrl,
      target
    );
  }
});
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(closeWorkerdHttp);
      yield* fs.remove(directory, { recursive: true, force: true });
    }).pipe(Effect.orDie)
  );
  const suffix = remote
    ? (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, proofNameSuffixLength)
    : "local";
  const name = `xlsx-proof-${suffix}`;
  yield* buildWorker(name);
  const target = remote
    ? Option.some(
        yield* hostedWorkerProof({
          directory,
          name,
          retirement: durable
            ? Option.some({
                config: proofConfig(name, true),
                worker:
                  "export default { fetch() { return new Response(null, { status: 404 }); } };",
              })
            : Option.none(),
        })
      )
    : Option.none<HostedWorkerProof>();
  if (!remote) yield* Effect.acquireRelease(Effect.sync(startWorker), releaseWorker);
  yield* waitReady(target);
  const debuggerUrl = remote ? "" : yield* waitInspector();
  yield* measureParserOnly(debuggerUrl, target);
  for (const fixture of yield* fixtures()) {
    yield* measure({ ...fixture, path: "/statement-work" }, debuggerUrl, target);
  }
  yield* overlapRequests(
    debuggerUrl,
    synthetic({ rows: 1000, text: " ".repeat(sharedLength - 4) + "Cafe", formatted: false }),
    { name: "two-overlapping-requests", target }
  );
  yield* overlapRequests(debuggerUrl, manyCells(boundedRows), {
    name: "two-overlapping-bounded-cell-requests",
    target,
  });
});
await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide([BunFileSystem.layer, BunCrypto.layer, proofHttpClientLayer])
  )
);
