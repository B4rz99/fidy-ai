import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { directoryName } from "../../directory/contract";
import { erasureRegistryName } from "../../erasure/contract";
import type { SharedBindings } from "../../storage-bootstrap/contract";
import { pricingName } from "../../subscription/contract";
import { completedCheckStatus, ownerCheckUrl } from "../contract";

const pageSize = 32;
const maximumUsers = 256;
const concurrency = 5;
const minuteMs = 60_000;
const tickMs = 55_000;
const probeMs = 1_000;
const cleanupMs = 100;

type Target = Readonly<{
  binding: SharedBindings[keyof SharedBindings];
  name: string;
  family: "directory" | "pricing" | "erasure" | "user";
}>;
type Outcome = "observed" | "repaired" | "failed" | "unsupported" | "unknown";
const unsupportedStatus = 404;
type Probe = Readonly<{ outcome: Outcome; unsettled: boolean }>;

const inspect = (response: Response): Promise<Outcome> => {
  // The protocol is bodyless. Cancel even an error body and keep its promise inside the budget.
  if (response.body !== null) return response.body.cancel().then(() => "failed");
  if (response.status === unsupportedStatus) return Promise.resolve("unsupported");
  const repair = response.headers.get("fidy-alarm-repaired");
  if (response.status !== completedCheckStatus || (repair !== "0" && repair !== "1")) {
    return Promise.resolve("failed");
  }
  return Promise.resolve(repair === "1" ? "repaired" : "observed");
};

/** The abort and body cancellation share the original deadline. Only settled cleanup frees the slot. */
const probe = Effect.fnUntraced(function* (target: Target, pending: Set<Promise<unknown>>) {
  if (target.binding === undefined) return { outcome: "failed", unsettled: false } satisfies Probe;

  const binding = target.binding;
  const started = yield* Clock.currentTimeMillis;
  const { result, observed } = yield* Effect.scoped(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      const work = Promise.resolve()
        .then(() => binding.getByName(target.name).fetch(ownerCheckUrl, { method: "POST", signal }))
        .then(inspect)
        .catch((): Outcome => "unknown");
      pending.add(work);
      const released = work.finally(() => {
        pending.delete(work);
      });
      const result = Effect.tryPromise(() => released).pipe(Effect.orDie);
      const observed = yield* result.pipe(Effect.timeoutOption(probeMs - cleanupMs));
      return { result, observed };
    })
  );
  if (Option.isSome(observed)) return { outcome: observed.value, unsettled: false };

  const remaining = Math.max(0, started + probeMs - (yield* Clock.currentTimeMillis));
  const settled = yield* result.pipe(Effect.timeoutOption(remaining));
  return { outcome: "unknown", unsettled: Option.isNone(settled) } satisfies Probe;
});

const Window = Schema.Struct({ cursor: Schema.String, last_user: Schema.String });
const Entry = Schema.Struct({ user_id: Schema.String });
const fixedTargets = (bindings: SharedBindings): Target[] => [
  { binding: bindings.DIRECTORY, name: directoryName, family: "directory" },
  { binding: bindings.PRICING, name: pricingName, family: "pricing" },
  { binding: bindings.ERASURE, name: erasureRegistryName, family: "erasure" },
];

const inspectBatch = Effect.fnUntraced(function* (
  cursor: string,
  batch: ReadonlyArray<Target>,
  pending: Set<Promise<unknown>>
) {
  const sql = yield* SqliteClient;
  // Checkpoint the admitted range before remote I/O. A crash leaves its outcome unobserved.
  // Only probes which return to this executor are counted as attempted.
  yield* sql`UPDATE watchdog_progress SET cursor=${cursor},admitted=admitted+${batch.length},unknown=unknown+${batch.length} WHERE singleton=1`;
  const replies = yield* Effect.forEach(batch, (target) => probe(target, pending), { concurrency });
  const repaired = replies.filter(({ outcome }) => outcome === "repaired").length;
  const observed = replies.filter(({ outcome }) => outcome === "observed").length + repaired;
  const failed = replies.filter(
    ({ outcome }) => outcome === "failed" || outcome === "unsupported"
  ).length;
  const attempted = batch.filter((target) => target.binding !== undefined).length;
  for (const [index, target] of batch.entries()) {
    if (target.family !== "user") {
      yield* Effect.logInfo({
        component: "watchdog",
        owner: target.family,
        outcome: replies[index]?.outcome,
      });
    }
  }
  yield* sql`UPDATE watchdog_progress SET attempted=attempted+${attempted}, observed=observed+${observed},
        failed=failed+${failed},unknown=unknown-${observed + failed},repaired=repaired+${repaired} WHERE singleton=1`;
  return replies.some(({ unsettled }) => unsettled);
});

const inspectPage = Effect.fnUntraced(function* ({
  targets,
  startCursor,
  deadline,
  pending,
}: Readonly<{
  targets: ReadonlyArray<Target>;
  startCursor: string;
  deadline: number;
  pending: Set<Promise<unknown>>;
}>) {
  let cursor = startCursor;
  for (let offset = 0; offset < targets.length; offset += concurrency) {
    if ((yield* Clock.currentTimeMillis) + probeMs > deadline) return "deadline" as const;
    const batch = targets.slice(offset, offset + concurrency);
    const last = batch.at(-1);
    if (last?.family === "user") cursor = last.name;
    if (yield* inspectBatch(cursor, batch, pending)) return "cleanup" as const;
  }
  return { cursor };
});

/** Freeze this tick's upper key. New tail registrations enter the next page, and inserts behind the cursor enter after wrap. */
export const runWatchdog = Effect.fn(function* (
  bindings: SharedBindings,
  scheduled: number,
  pending: Set<Promise<unknown>>
) {
  const sql = yield* SqliteClient;
  const started = yield* Clock.currentTimeMillis;
  const minute = Math.floor(started / minuteMs);
  const claimed =
    yield* sql`UPDATE watchdog_progress SET minute=${minute},scheduled=${scheduled},halt='running',
    admitted=0,attempted=0,observed=0,failed=0,unknown=0,repaired=0
    WHERE singleton=1 AND minute<${minute} AND scheduled<${scheduled} RETURNING cursor,coalesce((SELECT max(user_id) FROM lifetime_registry WHERE retired=0),'') AS last_user`;
  if (claimed.length === 0) return "coalesced" as const;
  const [window] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Window]))(claimed);
  let cursor = window.cursor;
  let remaining = maximumUsers;
  const shared = fixedTargets(bindings);
  while (remaining > 0) {
    const limit = Math.min(pageSize, remaining);
    const page = yield* Schema.decodeUnknownEffect(Schema.Array(Entry))(
      yield* sql`SELECT user_id FROM lifetime_registry WHERE retired=0 AND user_id>${cursor} AND user_id<=${window.last_user}
        ORDER BY user_id LIMIT ${limit}`
    );
    const targets = [
      ...shared.splice(0),
      ...page.map(({ user_id }) => ({
        binding: bindings.USER_STORE,
        name: user_id,
        family: "user" as const,
      })),
    ];
    const next = yield* inspectPage({
      targets,
      startCursor: cursor,
      deadline: started + tickMs,
      pending,
    });
    if (typeof next === "string") return next;
    cursor = next.cursor;
    remaining -= page.length;
    if (page.length < limit || cursor === window.last_user) {
      const wrapped = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE watchdog_progress SET cursor='',wraps=wraps+1,wrapped_at=${wrapped} WHERE singleton=1`;
      return "wrapped" as const;
    }
  }
  return "capacity" as const;
});

export const reportWatchdog = Effect.fnUntraced(function* (
  halt: Effect.Success<ReturnType<typeof runWatchdog>>
) {
  if (halt === "coalesced") return;
  const sql = yield* SqliteClient;
  const [counts] =
    yield* sql`UPDATE watchdog_progress SET halt=${halt} WHERE singleton=1 RETURNING halt,admitted,attempted,observed,failed,unknown,repaired,wraps,wrapped_at`;
  yield* Effect.logInfo({ component: "watchdog", ...counts });
});
