import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import { StoreCapacity, type StoreHistory } from "../runtime/sqlite/contract";
import { type createStoreRuntime, openSqliteStore } from "../runtime/sqlite/operations";
import { newId } from "../secret-material/operations";
import {
  StorageAdmission,
  type StorageCommand,
  localStorageOperatorUrl,
  storagePermission,
} from "./contract";
import {
  claimOperationEvidence,
  expireTargetEvidence,
  finishOperationEvidence,
  forgetExpiredReceipts,
} from "./evidence";

const successStatus = 200;
const pendingStatus = 202;
const noContent = 204;
const serverFailure = 500;
const lifetimeMs = 5000;
const maxAttempts = 3;
const unavailable = (): Response => new Response(null, { status: 503 });
const conflict = (): Response => new Response(null, { status: 409 });
const forbidden = (): Response => new Response(null, { status: 403 });
const privatePolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 2048,
  deadlineMilliseconds: lifetimeMs,
});
type OwnerAction = (command: StorageCommand, deadline: number) => Promise<Response>;
type Config = Partial<Readonly<{ watchdog: Effect.Effect<unknown, Error, SqliteClient> }>> &
  Readonly<{
    state: DurableObjectState;
    runtime: ReturnType<typeof createStoreRuntime>;
    history: StoreHistory;
    release: string;
  }>;
type Store = Config & {
  readiness: string;
  automaticRetryAt: number;
  failureObservation: Effect.Effect<void>;
};
type Requirements = SqliteClient | SqlClient.SqlClient | StoreCapacity;
type Manual = NonNullable<Parameters<typeof openSqliteStore>[2]>;
type Admission = typeof StorageAdmission.Type;
type Guard = (request: Request, action?: OwnerAction) => Option.Option<Promise<Response>>;
const attemptState = Effect.fnUntraced(function* ({ history, release }: Store) {
  const sql = yield* SqliteClient;
  const [row] =
    yield* sql`SELECT coalesce(max(version),0) AS version FROM store_migrations WHERE owner=${history.owner}`;
  const version = yield* Schema.decodeUnknownEffect(Schema.Int)(row?.version);
  const [next] =
    yield* sql`SELECT version,attempts,retry_at_ms,terminal FROM store_migration_attempts WHERE release=${release} AND version=${version + 1}`;
  return { version, next: next ?? null };
});
const automaticRetry = (
  next: Effect.Success<ReturnType<typeof attemptState>>["next"],
  terminal: boolean
): number => {
  if (next === null || terminal || Number(next.attempts) >= maxAttempts) {
    return Number.POSITIVE_INFINITY;
  }
  return Number(next.retry_at_ms);
};
const reportFailure = Effect.fnUntraced(function* ({
  store,
  reason,
  next,
  terminal,
}: {
  store: Store;
  reason: string;
  terminal: boolean;
  next: Effect.Success<ReturnType<typeof attemptState>>["next"];
}) {
  yield* Effect.logWarning({
    message: `fidy.operational component=sqlite operation=${store.history.owner} state=migration-failed severity=${terminal ? "critical" : "warning"}`,
    reason,
    attempts: next?.attempts ?? null,
    version: next?.version ?? null,
  });
});
const failed = Effect.fnUntraced(function* (store: Store, reason: string) {
  store.readiness = reason;
  const progress = yield* attemptState(store).pipe(Effect.option);
  const next = Option.getOrNull(
    Option.flatMap(progress, (entry) => Option.fromNullishOr(entry.next))
  );
  const terminal =
    next?.terminal === 1 ||
    ["invalid_history", "history_mismatch", "layout_mismatch"].includes(reason);
  store.automaticRetryAt = automaticRetry(next, terminal);
  store.failureObservation = reportFailure({ store, reason, next, terminal });
  yield* store.failureObservation;
});
const open = Effect.fnUntraced(function* (store: Store, manual?: Manual) {
  yield* openSqliteStore(store.history, store.release, manual).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        store.readiness = "ready";
        store.automaticRetryAt = Number.POSITIVE_INFINITY;
      })
    ),
    Effect.catch((error) => failed(store, error.reason))
  );
});
const inspect = Effect.fnUntraced(function* (store: Store) {
  const capacity = yield* (yield* StoreCapacity).measure.pipe(Effect.option);
  const progress = yield* attemptState(store).pipe(Effect.option);
  const watchdog =
    store.watchdog !== undefined && isReady(store) ? yield* store.watchdog : undefined;
  return Response.json(
    {
      owner: store.history.owner,
      release: store.release,
      readiness: store.readiness,
      expectedVersion: store.history.steps.length,
      ...Option.getOrElse(progress, () => ({ version: null, next: null })),
      ...Option.getOrElse(capacity, () => ({ bytes: null, ceilingBytes: null, band: null })),
      watchdog,
    },
    { headers: { "cache-control": "no-store" } }
  );
});
const isReady = (store: Store): boolean => store.readiness === "ready";
const retryEligible = (next: Readonly<Record<string, unknown>>): boolean =>
  next.terminal === 1 || next.attempts === maxAttempts;
const matchesAttempt = (
  command: Extract<StorageCommand, { action: "retry-migration" }>,
  progress: Effect.Success<ReturnType<typeof attemptState>>
): boolean =>
  progress.version + 1 === command.version &&
  progress.next !== null &&
  progress.next.attempts === command.attempt &&
  progress.next.retry_at_ms === command.retryAtMs &&
  retryEligible(progress.next);
const retry = Effect.fnUntraced(function* (
  store: Store,
  command: Extract<StorageCommand, { action: "retry-migration" }>,
  deadline: number
) {
  if (command.release !== store.release || store.readiness === "ready") return conflict();
  const progress = yield* attemptState(store);
  if (!matchesAttempt(command, progress)) return conflict();
  yield* open(store, {
    version: command.version,
    attempt: command.attempt,
    retryAtMs: command.retryAtMs,
    deadline,
  });
  return isReady(store) ? yield* inspect(store) : unavailable();
});
const allowed = (
  store: Store,
  { command, permission, deadline }: Admission,
  now: number
): boolean =>
  permission === storagePermission(command) &&
  command.owner === store.history.owner &&
  (command.owner !== "user" || command.userId === store.state.id.name) &&
  deadline > now &&
  deadline <= now + lifetimeMs;
const outcomeOf = (response: Response): string => {
  if (response.status >= serverFailure) return "unknown";
  if (response.status === pendingStatus) return "pending";
  return response.ok ? "observed" : "refused";
};
const evidenceTarget = (command: StorageCommand): string => {
  if ("operationId" in command) return command.operationId;
  return command.owner === "user" ? command.userId : command.owner;
};
const dispatch = Effect.fnUntraced(function* (
  store: Store,
  { command, deadline }: Admission,
  action: OwnerAction
) {
  if ((yield* Clock.currentTimeMillis) >= deadline) return forbidden();
  if (command.action === "inspect") return yield* inspect(store);
  if (command.action === "retry-migration") {
    const work = retry(store, command, deadline);
    return yield* Effect.tryPromise(() =>
      store.state.blockConcurrencyWhile(() => store.runtime.runPromise(work))
    );
  }
  return store.readiness === "ready"
    ? yield* Effect.tryPromise(() => action(command, deadline))
    : unavailable();
});
const knownOwner = Effect.fnUntraced(function* (store: Store, command: StorageCommand) {
  if (command.owner !== "user" || !isReady(store)) return true;
  const sql = yield* SqliteClient;
  return (yield* sql`SELECT 1 FROM users WHERE id=${command.userId} LIMIT 1`).length === 1;
});
const migrationCoordinate = (command: StorageCommand): Record<string, unknown> =>
  command.action === "retry-migration"
    ? {
        release: command.release,
        version: command.version,
        attempt: command.attempt,
        retryAtMs: command.retryAtMs,
      }
    : {};
const operate = Effect.fnUntraced(function* (store: Store, request: Request, action: OwnerAction) {
  const body = yield* boundedJsonBody({ request, policy: privatePolicy, schema: StorageAdmission });
  if (Option.isNone(body)) return new Response(null, { status: 400 });
  const now = yield* Clock.currentTimeMillis;
  const admission = body.value;
  if (!allowed(store, admission, now)) return forbidden();
  const { command, issuer, operator } = admission;
  if ("operationId" in command && store.readiness !== "ready") return unavailable();
  const key = command.action === "retry-migration" ? command.commandId : newId();
  const evidence = {
    issuer,
    operator,
    target: evidenceTarget(command),
    action: command.action,
    time: now,
    outcome: "unknown",
    ...migrationCoordinate(command),
  };
  if (!(yield* knownOwner(store, command))) return new Response(null, { status: 404 });
  const storage = store.state.storage;
  yield* Effect.try(() => forgetExpiredReceipts({ storage, now }));
  const status = yield* claimOperationEvidence({ cmd: command, storage, key, evidence });
  if (status !== successStatus) return new Response(null, { status });
  const response = yield* dispatch(store, admission, action).pipe(
    Effect.catchCause(() => Effect.succeed(unavailable()))
  );
  yield* finishOperationEvidence({
    cmd: command,
    storage,
    key,
    evidence: {
      ...evidence,
      outcome: outcomeOf(response),
    },
  });
  return response;
});
const prune = Effect.fnUntraced(function* (store: Store) {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.try(() => forgetExpiredReceipts({ storage: store.state.storage, now }));
  if (["user", "directory", "pricing"].includes(store.history.owner)) {
    yield* expireTargetEvidence(now);
  }
});
const observeAlarm = Effect.fnUntraced(function* (
  store: Store,
  before: Awaited<ReturnType<DurableObjectStorage["getAlarm"]>>,
  reply: Response
) {
  const now = yield* Clock.currentTimeMillis;
  const repaired = reply.headers.get("fidy-alarm-repaired") === "1";
  if (!repaired && (before === null || before >= now)) return;
  let alarm = "rescheduled";
  if (before === null) alarm = "missing";
  else if (before < now) alarm = "overdue";
  yield* Effect.logInfo({
    component: "watchdog",
    operation: "alarm",
    owner: store.history.owner,
    overdueAgeMs: before === null ? null : Math.max(0, now - before),
    message: `fidy.operational component=watchdog operation=${store.history.owner} state=alarm-${alarm} severity=${alarm === "missing" ? "warning" : "none"}`,
  });
});
const observeCheck = Effect.fnUntraced(function* <E, R>(
  store: Store,
  work: Effect.Effect<Response, E, R>
) {
  const before = yield* Effect.tryPromise(() => store.state.storage.getAlarm());
  const reply = yield* work;
  if (reply.status !== noContent) return reply;
  yield* observeAlarm(store, before, reply);
  yield* prune(store);
  const capacity = yield* (yield* StoreCapacity).measure;
  reply.headers.set("fidy-schema-version", String(store.history.steps.length));
  reply.headers.set("fidy-storage-band", capacity.band);
  reply.headers.set("fidy-schema-release", store.release);
  return reply;
});
const guard =
  (store: Store): Guard =>
  (request, action = () => Promise.resolve(conflict())) => {
    if (request.method === "POST" && request.url === localStorageOperatorUrl) {
      return Option.some(
        store.runtime.runPromise(
          operate(store, request, action).pipe(
            Effect.catchCause(() => Effect.succeed(unavailable()))
          )
        )
      );
    }
    if (store.readiness === "ready") return Option.none();
    if (request.url === "https://owner.internal/work/check") {
      store.state.waitUntil(store.runtime.runPromise(store.failureObservation));
    }
    if (Effect.runSync(Clock.currentTimeMillis) >= store.automaticRetryAt) {
      store.automaticRetryAt = Number.POSITIVE_INFINITY;
      store.state.waitUntil(
        store.state.blockConcurrencyWhile(() => store.runtime.runPromise(open(store)))
      );
    }
    return Option.some(Promise.resolve(unavailable()));
  };
type StorageControl = Readonly<{
  open: () => Effect.Effect<void, never, Requirements>;
  failed: () => boolean;
  guard: Guard;
  prune: ReturnType<typeof prune>;
  observeCheck: <E, R>(
    work: Effect.Effect<Response, E, R>
  ) => Effect.Effect<
    Response,
    E | Effect.Error<ReturnType<typeof observeCheck<never, never>>>,
    R | Requirements
  >;
}>;
/** Constructor readiness fences every normal entry while fixed private diagnostics remain available. */
export const createStorageControl = (config: Config): StorageControl => {
  const store = {
    ...config,
    readiness: "ready",
    failureObservation: Effect.void,
    automaticRetryAt: Number.POSITIVE_INFINITY,
  };
  return {
    open: () => open(store),
    failed: () => store.readiness !== "ready",
    guard: guard(store),
    prune: prune(store),
    observeCheck: (work) => observeCheck(store, work),
  };
};
