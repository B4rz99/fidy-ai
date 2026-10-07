import { Clock, Data, DateTime, Effect, FileSystem, Schema, Stream } from "effect";
import { tmpdir } from "node:os";

export class VerificationFailure extends Data.TaggedError("VerificationFailure")<{
  readonly message: string;
}> {}
export const attempt = Effect.fn(function <Value>(
  message: string,
  run: (signal: AbortSignal) => Promise<Value>
): Effect.Effect<Value, VerificationFailure> {
  return Effect.tryPromise({ try: run, catch: () => new VerificationFailure({ message }) });
});
const WINDOW_MINUTES = 30;
const APPROVAL_MAX_AGE_MS = 900_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const COMMAND_OUTPUT_LIMIT = 2_000_000;
const identifier = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
);
const binaryPath = Schema.String.check(Schema.isPattern(/^\/.+$/u));
const opaqueName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,96}$/u));
export const Scope = Schema.Struct({
  approved: Schema.Literal(true),
  authorization: Schema.NonEmptyString,
  approvedAt: Schema.String,
  namespace: opaqueName,
  fixtureUserId: identifier,
  portfolio: opaqueName,
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  databaseId: identifier,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  coreVersion: identifier,
  ingressVersion: identifier,
  workers: Schema.Struct({ core: opaqueName, ingress: opaqueName }),
  binaries: Schema.Struct({ claude: binaryPath, codex: binaryPath }),
  windowMinutes: Schema.Literal(WINDOW_MINUTES),
  maximumRequests: Schema.Literal(100),
});
export type ApprovedScope = typeof Scope.Type;
export const requireCheck = Effect.fn(function (
  passed: boolean,
  message: string
): Effect.Effect<void, VerificationFailure> {
  return passed ? Effect.void : Effect.fail(new VerificationFailure({ message }));
});
export const readJson = Effect.fn(function <Value>(
  codec: Schema.Codec<Value>,
  path: string
): Effect.Effect<Value, VerificationFailure> {
  return attempt<unknown>("Cannot read private verification state", () =>
    Bun.file(path).json()
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(codec)),
    Effect.mapError(() => new VerificationFailure({ message: "Invalid verification state" }))
  );
});
export const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);
export const writeJson = Effect.fn(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(path, encodeJson(value) + "\n", { mode: 0o600 })
    .pipe(
      Effect.mapError(() => new VerificationFailure({ message: "Cannot write verification state" }))
    );
});
export const readScope = Effect.fn(function* (path: string) {
  const approval = yield* readJson(Schema.Struct({ approved: Schema.Boolean }), path);
  yield* requireCheck(approval.approved, "Explicit synthetic authorization required");
  const scope = yield* readJson(Scope, path);
  const now = yield* Clock.currentTimeMillis;
  const approved = yield* Effect.try({
    try: () => DateTime.toEpochMillis(DateTime.makeUnsafe(scope.approvedAt)),
    catch: () => new VerificationFailure({ message: "Invalid approval timestamp" }),
  });
  yield* requireCheck(
    approved <= now && now - approved < APPROVAL_MAX_AGE_MS,
    "Synthetic approval is stale or in the future"
  );
  return scope;
});
export const privateDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: tmpdir(), prefix: "fidy-mcp-proof-" }).pipe(
      Effect.tap((root) => fs.chmod(root, PRIVATE_DIRECTORY_MODE)),
      Effect.mapError(
        () => new VerificationFailure({ message: "Cannot create private verification directory" })
      )
    ),
    (root) => fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
  );
  // Native clients derive profile identity from the canonical working directory.
  return yield* fs
    .realPath(root)
    .pipe(
      Effect.mapError(
        () => new VerificationFailure({ message: "Cannot resolve private verification directory" })
      )
    );
});
const commandOutput = Effect.fn(function* (
  stream: ReadableStream<Uint8Array>,
  budget: { bytes: number }
) {
  const decoder = new TextDecoder();
  const chunks = yield* Stream.runCollect(
    Stream.fromReadableStream({
      evaluate: () => stream,
      onError: () => new VerificationFailure({ message: "Verification command stream failed" }),
    }).pipe(
      Stream.mapEffect((chunk) => {
        budget.bytes += chunk.byteLength;
        return requireCheck(
          budget.bytes <= COMMAND_OUTPUT_LIMIT,
          "Verification command exceeded its output bound"
        ).pipe(Effect.as(decoder.decode(chunk, { stream: true })));
      })
    )
  );
  return chunks.join("") + decoder.decode();
});
const stopCommand = (child: Bun.Subprocess): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (child.exitCode === null) {
      child.kill();
    }
    yield* attempt("Verification command did not stop", () => child.exited).pipe(
      Effect.timeoutOption("2 seconds")
    );
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      yield* attempt("Verification command did not stop", () => child.exited).pipe(
        Effect.timeout("2 seconds")
      );
    }
  }).pipe(Effect.orDie);
export const command = Effect.fn(function (
  args: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string>> = {}
): Effect.Effect<string, VerificationFailure> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([...args], {
            cwd,
            env: { ...process.env, ...environment },
            stdout: "pipe",
            stderr: "pipe",
          })
        ),
        stopCommand
      );
      const budget = { bytes: 0 };
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          commandOutput(child.stdout, budget),
          commandOutput(child.stderr, budget),
          attempt("Verification command failed", () => child.exited),
        ],
        { concurrency: 3 }
      );
      yield* requireCheck(
        stdout.length + stderr.length <= COMMAND_OUTPUT_LIMIT && exitCode === 0,
        "Verification command failed or exceeded its output bound"
      );
      return stdout;
    })
  ).pipe(
    Effect.timeout("45 seconds"),
    Effect.mapError(() => new VerificationFailure({ message: "Verification command failed" }))
  );
});
const D1Result = Schema.Array(
  Schema.Struct({
    success: Schema.Boolean,
    results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    meta: Schema.Struct({ changes: Schema.Finite }),
  })
);
export const query = Effect.fn(function* (scope: ApprovedScope, sql: string) {
  const text = yield* command(
    [
      process.execPath,
      "node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      scope.databaseId,
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    process.cwd(),
    { CLOUDFLARE_ACCOUNT_ID: scope.accountId }
  );
  const rows = yield* Schema.decodeEffect(Schema.fromJsonString(D1Result))(text).pipe(
    Effect.mapError(
      () => new VerificationFailure({ message: "D1 verification response was invalid" })
    )
  );
  yield* requireCheck(
    rows.every((row) => row.success),
    "D1 verification did not succeed"
  );
  return rows.flatMap((row) => row.results);
});
export const approvePairing = Effect.fn(function* (scope: ApprovedScope, code: string) {
  yield* requireCheck(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(code), "Unexpected browser pairing code");
  const now = yield* Clock.currentTimeMillis;
  yield* query(
    scope,
    `INSERT INTO browser_login_approvals (portfolio_id,message_id,pairing_id,user_id) SELECT '${scope.portfolio}','${scope.namespace}-fixture-'||id,id,'${scope.fixtureUserId}' FROM browser_login_pairings WHERE public_code='${code}' AND state='pending_approval' AND expires_at_ms>${now};`
  );
});
export const Snapshot = Schema.Struct({
  users: Schema.Finite,
  synthetic: Schema.Finite,
  activeConnections: Schema.Finite,
  activeBrowsers: Schema.Finite,
  budgets: Schema.Finite,
  transactions: Schema.Finite,
  refreshEvents: Schema.Finite,
  createdBudgets: Schema.Finite,
  deletedBudgets: Schema.Finite,
  rejectedDeletions: Schema.Finite,
  createdTransactions: Schema.Finite,
});
export type FixtureSnapshot = typeof Snapshot.Type;
export const snapshot = Effect.fn(function* (scope: ApprovedScope) {
  const user = scope.fixtureUserId;
  const rows = yield* query(
    scope,
    `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM verified_email_credentials WHERE user_id='${user}' AND email_address LIKE '%@example.invalid') AS synthetic, (SELECT count(*) FROM oauth_connections WHERE user_id='${user}' AND revoked_at_ms IS NULL) AS activeConnections, (SELECT count(*) FROM web_sessions WHERE user_id='${user}' AND revoked_at_ms IS NULL) AS activeBrowsers, (SELECT count(*) FROM budgets WHERE user_id='${user}') AS budgets, (SELECT count(*) FROM transactions WHERE user_id='${user}') AS transactions, (SELECT count(*) FROM oauth_refresh_events WHERE user_id='${user}') AS refreshEvents, (SELECT count(*) FROM pat_audit WHERE user_id='${user}' AND operation='budgets.createBudget' AND outcome='accepted') AS createdBudgets, (SELECT count(*) FROM pat_audit WHERE user_id='${user}' AND operation='budgets.deleteBudget' AND outcome='accepted') AS deletedBudgets, (SELECT count(*) FROM pat_audit WHERE user_id='${user}' AND operation='budgets.deleteBudget' AND outcome='rejected') AS rejectedDeletions, (SELECT count(*) FROM pat_audit WHERE user_id='${user}' AND operation='transactions.createTransaction' AND outcome='accepted') AS createdTransactions;`
  );
  return yield* Schema.decodeUnknownEffect(Snapshot)(rows[0]).pipe(
    Effect.mapError(() => new VerificationFailure({ message: "Fixture inventory was invalid" }))
  );
});
