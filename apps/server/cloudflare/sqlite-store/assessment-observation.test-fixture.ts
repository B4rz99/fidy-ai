import type { DashboardDocumentEnvironment } from "../dashboard/contract";
import { AsyncLocalStorage } from "node:async_hooks";
import { Clock, Effect, Schema } from "effect";

export const AssessmentNativeCounters = Schema.Struct({
  nativeRpc: Schema.mutableKey(Schema.Int),
  entryRpc: Schema.mutableKey(Schema.Int),
  nativeClock: Schema.mutableKey(Schema.Finite),
  genericRpc: Schema.mutableKey(Schema.Int),
  r2Get: Schema.mutableKey(Schema.Int),
  r2Head: Schema.mutableKey(Schema.Int),
  r2Put: Schema.mutableKey(Schema.Int),
  r2Delete: Schema.mutableKey(Schema.Int),
  r2List: Schema.mutableKey(Schema.Int),
});
export type AssessmentNativeCounters = typeof AssessmentNativeCounters.Type;
export const assessmentNativeContext = new AsyncLocalStorage<AssessmentNativeCounters>();
export const emptyAssessmentCounters = (): AssessmentNativeCounters => ({
  nativeRpc: 0,
  entryRpc: 0,
  nativeClock: 0,
  genericRpc: 0,
  r2Get: 0,
  r2Head: 0,
  r2Put: 0,
  r2Delete: 0,
  r2List: 0,
});
const operations = {
  get: "r2Get",
  head: "r2Head",
  put: "r2Put",
  delete: "r2Delete",
  list: "r2List",
} as const;
const Operation = Schema.Literals(["get", "head", "put", "delete", "list"]);

/** Observe actual platform operations in this invocation's async context, without changing results. */
export const observeAssessmentBucket = (bucket: R2Bucket): R2Bucket =>
  new Proxy(bucket, {
    get: (target, key): unknown => {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: ReadonlyArray<unknown>): unknown => {
        const operation = Schema.decodeUnknownOption(Operation)(key);
        const counts = assessmentNativeContext.getStore();
        if (operation._tag === "Some" && counts !== undefined) {
          counts[operations[operation.value]]++;
        }
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
export const observeAssessmentCall = <A extends object>(
  execute: () => Promise<A>
): Promise<A & Readonly<{ fixtureCounters: AssessmentNativeCounters }>> => {
  const counters = {
    ...emptyAssessmentCounters(),
    nativeRpc: 1,
    nativeClock: Effect.runSync(Clock.currentTimeMillis),
  };
  return assessmentNativeContext.run(counters, () =>
    execute().then((result) => ({ ...result, fixtureCounters: counters }))
  );
};

const ObservedResult = Schema.Struct({ fixtureCounters: AssessmentNativeCounters });
const r2Keys = ["r2Get", "r2Head", "r2Put", "r2Delete", "r2List"] as const;
const recordNativeResult = (result: unknown): unknown => {
  const decoded = Schema.decodeUnknownOption(ObservedResult)(result);
  const counts = assessmentNativeContext.getStore();
  if (decoded._tag === "Some" && counts !== undefined) {
    for (const key of r2Keys) counts[key] += decoded.value.fixtureCounters[key];
    counts.nativeClock = decoded.value.fixtureCounters.nativeClock;
  }
  return result;
};

/** The wrapper counts calls to the provider binding, rather than inferring them from SQL timing. */
export const observeAssessmentNamespace = (
  namespace: NonNullable<DashboardDocumentEnvironment["SQLITE_STORE"]>
): typeof namespace => ({
  getByName: (name) => {
    const store = namespace.getByName(name);
    return {
      query: (input) => {
        const counts = assessmentNativeContext.getStore();
        if (counts !== undefined) counts.genericRpc++;
        return Promise.resolve(store.query(input));
      },
      dashboard: (input) => {
        const counts = assessmentNativeContext.getStore();
        if (counts !== undefined) counts.nativeRpc++;
        return Promise.resolve(store.dashboard(input)).then(recordNativeResult);
      },
    };
  },
});

export const observeAssessmentDocumentCall = <A extends object>(
  execute: () => Promise<A>
): Promise<A & Readonly<{ fixtureCounters: AssessmentNativeCounters }>> => {
  const counters = { ...emptyAssessmentCounters(), entryRpc: 1 };
  return assessmentNativeContext.run(counters, () =>
    execute().then((result) => ({ ...result, fixtureCounters: counters }))
  );
};

export const assessmentCounterHeaders = (
  counts: AssessmentNativeCounters
): Readonly<Record<string, string>> => ({
  "fidy-assessment-native-rpc": String(counts.nativeRpc),
  "fidy-assessment-entry-rpc": String(counts.entryRpc),
  "fidy-assessment-native-clock": String(counts.nativeClock),
  "fidy-assessment-generic-rpc": String(counts.genericRpc),
  "fidy-assessment-r2-get": String(counts.r2Get),
  "fidy-assessment-r2-head": String(counts.r2Head),
  "fidy-assessment-r2-put": String(counts.r2Put),
  "fidy-assessment-r2-delete": String(counts.r2Delete),
  "fidy-assessment-r2-list": String(counts.r2List),
});
