#!/usr/bin/env bun
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Schema } from "effect";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx/xlsx.mjs";
import type { WorkBook, WorkSheet } from "xlsx";
import { closeWorkerdHttp, requestWorkerd } from "./local-workerd-http";
import { heapUsage, inspectorTarget, profileWorkerRequest } from "./workerd-inspector";

const baseline = process.argv.includes("--baseline");
const port = 8795;
const inspectorPort = 9295;
const readinessAttempts = 80;
const readinessDelay = 500;
const requestTimeout = 1000;
const cpuLimit = 30000;
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
const rejected = Schema.Struct({ outcome: Schema.Literal("rejected"), reason: Schema.String });
const decodeResponse = Schema.decodeUnknownSync(Schema.Union([workResult, rejected]));

const measurementBase = Schema.Struct({
  baseline: Schema.Boolean,
  fixture: Schema.String,
  zipBytes: Schema.Int,
  expandedBytes: Schema.Int,
  sampledV8ActiveMilliseconds: Schema.Finite,
  retainedHeapBeforeBytes: Schema.Int,
  retainedHeapAfterBytes: Schema.Int,
});
const measurementCodec = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ...measurementBase.fields, ...workResult.fields }),
    Schema.Struct({ ...measurementBase.fields, ...rejected.fields }),
  ])
);
const overlapCodec = Schema.fromJsonString(
  Schema.Struct({
    baseline: Schema.Boolean,
    fixture: Schema.String,
    elapsedMilliseconds: Schema.Finite,
    outcomes: Schema.Array(Schema.Literals(["parsed", "rejected"])),
    retainedHeapAfterBytes: Schema.Int,
  })
);
const configCodec = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    main: Schema.String,
    compatibility_date: Schema.String,
    limits: Schema.Struct({ cpu_ms: Schema.Int }),
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
const send = (bytes: Uint8Array, signal: AbortSignal): Promise<Response> =>
  requestWorkerd({
    method: "POST",
    port,
    path: "/statement-work",
    body: bytes,
    headers: {},
    signal,
  });
const waitReady = Effect.fn(function* () {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const response = yield* Effect.result(
      Effect.tryPromise(() =>
        send(
          synthetic({ rows: 1, text: "Cafe", formatted: false }),
          AbortSignal.timeout(requestTimeout)
        ).then((value) => value.arrayBuffer())
      )
    );
    if (response._tag === "Success") return;
    yield* Effect.sleep(readinessDelay);
  }
  throw new Error("XLSX proof worker did not become ready");
});
const measure = Effect.fn(function* (
  fixture: Readonly<{ name: string; bytes: Uint8Array }>,
  debuggerUrl: string
) {
  const expandedBytes = Object.values(unzipSync(fixture.bytes)).reduce(
    (sum, entry) => sum + entry.length,
    0
  );
  const before = yield* Effect.tryPromise(() => heapUsage({ debuggerUrl, signal: Option.none() }));
  const profiled = yield* Effect.tryPromise(() =>
    profileWorkerRequest({
      debuggerUrl,
      signal: Option.none(),
      sendRequest: (signal) => send(fixture.bytes, signal),
    })
  );
  const result = decodeResponse(yield* Effect.tryPromise(() => profiled.response.json()));
  const after = yield* Effect.tryPromise(() => heapUsage({ debuggerUrl, signal: Option.none() }));
  const output = yield* Schema.encodeEffect(measurementCodec)({
    baseline,
    fixture: fixture.name,
    zipBytes: fixture.bytes.length,
    expandedBytes,
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
      { cwd: root }
    ).stdout.toString()
  : "";
const proofConfig = (): string =>
  Schema.encodeSync(configCodec)({
    name: "xlsx-work-proof",
    main: "worker.js",
    compatibility_date: "2026-09-08",
    limits: { cpu_ms: cpuLimit },
  });
const buildWorker = Effect.fn(function* () {
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
      entrypoints: [`${root}/apps/server/cloudflare/documents/document-parsing-worker.ts`],
      target: "browser",
      outdir: directory,
      naming: "worker.js",
    })
  );
  if (!built.success) throw new Error("XLSX proof bundle failed");
  yield* Effect.tryPromise(() => Bun.write(`${directory}/wrangler.json`, proofConfig()));
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
    { stdout: Bun.file("/tmp/fidy-1159-worker.log"), stderr: "inherit" }
  );

const overlapRequests = Effect.fn(function* (
  debuggerUrl: string,
  overlap: Uint8Array,
  name: string
) {
  const startedAt = performance.now();
  const responses = yield* Effect.tryPromise(() =>
    Promise.all([
      send(overlap, AbortSignal.timeout(cpuLimit)),
      send(overlap, AbortSignal.timeout(cpuLimit)),
    ])
  );
  const results = yield* Effect.forEach(responses, (response) =>
    Effect.tryPromise(() => response.json()).pipe(Effect.map(decodeResponse))
  );
  const retainedHeapAfterBytes = yield* Effect.tryPromise(() =>
    heapUsage({ debuggerUrl, signal: Option.none() })
  );
  const output = yield* Schema.encodeEffect(overlapCodec)({
    baseline,
    fixture: name,
    elapsedMilliseconds: performance.now() - startedAt,
    outcomes: results.map((result) => result.outcome),
    retainedHeapAfterBytes,
  });
  process.stdout.write(output + "\n");
});
const releaseWorker = Effect.fn(function* (worker: ReturnType<typeof Bun.spawn>) {
  const fs = yield* FileSystem.FileSystem;
  worker.kill();
  yield* Effect.tryPromise(() => worker.exited);
  yield* Effect.tryPromise(closeWorkerdHttp);
  yield* fs.remove(directory, { recursive: true, force: true });
}, Effect.orDie);
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* buildWorker();
  yield* Effect.acquireRelease(Effect.sync(startWorker), releaseWorker);
  yield* waitReady();
  const debuggerUrl = yield* Effect.tryPromise(() =>
    inspectorTarget({ port: inspectorPort, signal: Option.none() })
  );
  for (const fixture of yield* fixtures()) yield* measure(fixture, debuggerUrl);
  yield* overlapRequests(
    debuggerUrl,
    synthetic({ rows: 1000, text: " ".repeat(sharedLength - 4) + "Cafe", formatted: false }),
    "two-overlapping-requests"
  );
  yield* overlapRequests(
    debuggerUrl,
    manyCells(boundedRows),
    "two-overlapping-bounded-cell-requests"
  );
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
