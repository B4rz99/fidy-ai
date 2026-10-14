import { Database } from "bun:sqlite";
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  CaseCommand,
  type CaseReceipt,
  RegisterFailure,
  RegisterRequest,
  TitularCase,
} from "./contract";
import { applyCaseCommand } from "./operations";
import { caseDeadlines } from "./calendar";

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const permissionMask = 0o777;
const applicationId = 1179206745;
const maximumBytes = 20_971_520;
const maximumCases = 1000;
const maximumEvents = 20000;
const commandCodec = Schema.fromJsonString(CaseCommand);
const caseCodec = Schema.fromJsonString(TitularCase);

const nativeCall = <A>(run: () => A): Effect.Effect<A, RegisterFailure> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof RegisterFailure ? cause : new RegisterFailure({ reason: "Unavailable" }),
  });
const isRepositoryPath = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = directory;
  while (path.dirname(current) !== current) {
    if (yield* fs.exists(path.join(current, ".git"))) return true;
    current = path.dirname(current);
  }
  return yield* fs.exists(path.join(current, ".git"));
});
const ownedPermissions = (
  input: Readonly<{ info: FileSystem.File.Info; uid: number; mode: number }>
): boolean =>
  Option.contains(input.uid)(input.info.uid) && (input.info.mode & permissionMask) === input.mode;

const checkDirectory = Effect.fn(function* (root: string, uid: number) {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* fs.stat(root);
  if (
    folder.type !== "Directory" ||
    !ownedPermissions({ info: folder, uid, mode: privateDirectoryMode }) ||
    (yield* fs.realPath(root)) !== root
  ) {
    return yield* new RegisterFailure({ reason: "UnsafeStorage" });
  }
});
const prepareFile = Effect.fn(function* (root: string, uid: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(root, "register.sqlite");
  const created = !(yield* fs.exists(target));
  if (created) yield* fs.writeFileString(target, "", { mode: privateFileMode, flag: "wx" });
  const file = yield* fs.stat(target);
  if (
    file.type !== "File" ||
    !ownedPermissions({ info: file, uid, mode: privateFileMode }) ||
    !Option.contains(1)(file.nlink)
  ) {
    return yield* new RegisterFailure({ reason: "UnsafeStorage" });
  }
  if (file.size > BigInt(maximumBytes) || (yield* fs.realPath(target)) !== target) {
    return yield* new RegisterFailure({ reason: "UnsafeStorage" });
  }
  return { path: target, created: created || file.size === 0n };
});
const privateStorage = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(directory);
  const uid = yield* Effect.sync(() => Option.fromNullishOr(process.getuid?.()));
  if (Option.isNone(uid) || (yield* isRepositoryPath(root))) {
    return yield* new RegisterFailure({ reason: "UnsafeStorage" });
  }
  if (!(yield* fs.exists(root))) yield* fs.makeDirectory(root, { mode: privateDirectoryMode });
  yield* checkDirectory(root, uid.value);
  return yield* prepareFile(root, uid.value);
});

const initialize = (db: Database, created: boolean): void => {
  if (!created) {
    Schema.decodeUnknownSync(Schema.Struct({ application_id: Schema.Literal(applicationId) }))(
      db.query("PRAGMA application_id").get()
    );
    return;
  }
  db.exec(`PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; PRAGMA application_id=${applicationId};
    CREATE TABLE cases (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
    CREATE TABLE events (command_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), command TEXT NOT NULL, snapshot TEXT NOT NULL, at_ms INTEGER NOT NULL); COMMIT;`);
};
const openRegister = Effect.fn(function* (directory: string) {
  const storage = yield* privateStorage(directory).pipe(
    Effect.mapError((failure) =>
      failure._tag === "RegisterFailure"
        ? failure
        : new RegisterFailure({ reason: "UnsafeStorage" })
    )
  );
  return yield* nativeCall(() => {
    const db = new Database(storage.path, { strict: true });
    try {
      initialize(db, storage.created);
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000");
      return db;
    } catch (cause) {
      db.close();
      throw cause;
    }
  });
});

const decodeSnapshot = (row: unknown): Effect.Effect<TitularCase, RegisterFailure> =>
  Schema.decodeUnknownEffect(Schema.Struct({ snapshot: Schema.String }))(row).pipe(
    Effect.flatMap((value) => Schema.decodeEffect(caseCodec)(value.snapshot)),
    Effect.mapError(() => new RegisterFailure({ reason: "Unavailable" }))
  );
const findCase = (
  input: Readonly<{ db: Database; caseId: string }>
): Effect.Effect<Option.Option<TitularCase>, RegisterFailure> =>
  nativeCall(() => input.db.query("SELECT snapshot FROM cases WHERE id=?").get(input.caseId)).pipe(
    Effect.flatMap((row) =>
      row === null ? Effect.succeedNone : decodeSnapshot(row).pipe(Effect.asSome)
    )
  );
const replay = (
  input: Readonly<{ db: Database; command: CaseCommand }>
): Effect.Effect<Option.Option<TitularCase>, RegisterFailure> =>
  Effect.gen(function* () {
    const row = yield* nativeCall(() =>
      input.db
        .query("SELECT command,snapshot FROM events WHERE command_id=?")
        .get(input.command.commandId)
    );
    if (row === null) return Option.none();
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ command: Schema.String, snapshot: Schema.String })
    )(row).pipe(Effect.mapError(() => new RegisterFailure({ reason: "Unavailable" })));
    const encoded = yield* Schema.encodeEffect(commandCodec)(input.command).pipe(
      Effect.mapError(() => new RegisterFailure({ reason: "InvalidInput" }))
    );
    if (stored.command !== encoded) {
      return yield* new RegisterFailure({ reason: "Conflict" });
    }
    return Option.some(yield* decodeSnapshot(stored));
  });

const storeCommand = (
  input: Readonly<{ db: Database; command: CaseCommand; next: TitularCase; atMs: number }>
): Effect.Effect<void, RegisterFailure> =>
  nativeCall(() => {
    const counts = Schema.decodeUnknownSync(
      Schema.Struct({ cases: Schema.Int, events: Schema.Int })
    )(
      input.db
        .query(
          "SELECT (SELECT COUNT(*) FROM cases) AS cases,(SELECT COUNT(*) FROM events) AS events"
        )
        .get()
    );
    if (
      counts.events >= maximumEvents ||
      (input.command.action === "Receive" && counts.cases >= maximumCases)
    ) {
      throw new RegisterFailure({ reason: "Unavailable" });
    }
    const snapshot = Schema.encodeSync(caseCodec)(input.next);
    input.db
      .query(
        "INSERT INTO cases(id,snapshot) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot"
      )
      .run(input.command.caseId, snapshot);
    input.db
      .query("INSERT INTO events(command_id,case_id,command,snapshot,at_ms) VALUES (?,?,?,?,?)")
      .run(
        input.command.commandId,
        input.command.caseId,
        Schema.encodeSync(commandCodec)(input.command),
        snapshot,
        input.atMs
      );
  });
const transact = (
  input: Readonly<{ db: Database; command: CaseCommand; atMs: number }>
): Effect.Effect<TitularCase, RegisterFailure> =>
  Effect.gen(function* () {
    yield* nativeCall(() => input.db.exec("BEGIN IMMEDIATE"));
    const existing = yield* replay(input);
    if (Option.isSome(existing)) {
      yield* nativeCall(() => input.db.exec("COMMIT"));
      return existing.value;
    }
    const previous = yield* findCase({ db: input.db, caseId: input.command.caseId });
    const next = yield* applyCaseCommand({ ...input, previous });
    yield* storeCommand({ ...input, next });
    yield* nativeCall(() => input.db.exec("COMMIT"));
    return next;
  }).pipe(Effect.uninterruptible);

const report = (value: TitularCase): CaseReceipt => {
  const targets = caseDeadlines(value);
  return {
    case: value,
    authority: "manual-record-only",
    deletion: "not-performed",
    targets: {
      provisional: true,
      calendar: "CO-2026-2027-saturdays-counted",
      response: targets.response,
      maximumExtension: targets.maximumExtension,
      completion: targets.completion,
      transfer: targets.transfer,
      calendarReviewRequired: Option.isNone(targets.response),
    },
  };
};

/** Private, bounded local operator ledger. Atomic replay preserves the original receipt and never executes product effects. */
export const runCaseRegister = Effect.fn(function* (
  input: Readonly<{ directory: string; request: unknown }>
) {
  const request = yield* Schema.decodeUnknownEffect(RegisterRequest, { onExcessProperty: "error" })(
    input.request
  ).pipe(Effect.mapError(() => new RegisterFailure({ reason: "InvalidInput" })));
  const atMs = yield* Clock.currentTimeMillis;
  return yield* Effect.acquireUseRelease(
    openRegister(input.directory),
    (db) =>
      Effect.gen(function* () {
        if (request.operation === "Apply") {
          return report(yield* transact({ db, command: request.command, atMs }));
        }
        const value = yield* findCase({ db, caseId: request.caseId });
        if (Option.isNone(value)) return yield* new RegisterFailure({ reason: "InvalidInput" });
        return report(value.value);
      }),
    (db) =>
      Effect.sync(() => {
        if (db.inTransaction) db.exec("ROLLBACK");
        db.close();
      })
  );
});
